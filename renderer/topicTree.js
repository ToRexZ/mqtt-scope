// Topic tree data model. Each MQTT topic level is a node; nodes that have
// received messages keep the latest message plus a bounded history.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class TopicNode {
  constructor(name, parent) {
    this.name = name;
    this.parent = parent;
    this.path = !parent ? '' : parent.parent ? `${parent.path}/${name}` : name;
    this.children = new Map();
    this.sorted = null;
    this.message = null;
    this.history = [];
    this.historySize = 0; // payload bytes held in history
    this.messageCount = 0; // messages on this exact topic
    this.subtreeMessages = 0; // including descendants
    this.subtreeTopics = 0; // topics with at least one message, including self
    this.lastUpdate = 0; // last message anywhere in this subtree
    this.selfUpdate = 0; // last message on this exact topic
    // A retained message was received for this topic (delivered with the
    // retain flag on subscribe). Cleared by an empty payload, which is how a
    // retained message is deleted. Only these topics offer "delete retained".
    this.retained = false;
    this.expanded = false;
  }

  sortedChildren() {
    if (!this.sorted) this.sorted = [...this.children.values()].sort((a, b) => collator.compare(a.name, b.name));
    return this.sorted;
  }

  *topics() {
    if (this.messageCount) yield this;
    for (const child of this.children.values()) yield* child.topics();
  }
}

export class TopicTree {
  // historyLimit: messages kept per topic. historyBytes: payload bytes kept per
  // topic; older messages are dropped first but the latest is always kept.
  constructor({ historyLimit = 100, historyBytes = 64 * 1024 * 1024 } = {}) {
    this.historyLimit = historyLimit;
    this.historyBytes = historyBytes;
    this.clear();
  }

  clear() {
    this.root = new TopicNode('', null);
    this.topicCount = 0;
    this.messageCount = 0;
  }

  // The node of a topic, made (with the levels above it) when missing.
  nodeFor(topic) {
    let node = this.root;
    for (const level of topic.split('/')) {
      let child = node.children.get(level);
      if (!child) {
        child = new TopicNode(level, node);
        node.children.set(level, child);
        node.sorted = null;
      }
      node = child;
    }
    return node;
  }

  addMessage(msg) {
    const node = this.nodeFor(msg.topic);
    const isNewTopic = node.messageCount === 0;
    node.message = msg;
    node.messageCount++;
    node.selfUpdate = msg.ts;
    if (msg.payload.length === 0) node.retained = false;
    else if (msg.retain) node.retained = true;
    node.history.push(msg);
    node.historySize += msg.payload.length;
    this.trim(node);
    for (let n = node; n; n = n.parent) {
      n.subtreeMessages++;
      if (isNewTopic) n.subtreeTopics++;
      n.lastUpdate = msg.ts;
    }
    if (isNewTopic) this.topicCount++;
    this.messageCount++;
    return node;
  }

  trim(node) {
    while (node.history.length > 1 && (node.history.length > this.historyLimit || node.historySize > this.historyBytes)) {
      node.historySize -= node.history.shift().payload.length;
    }
  }

  // Applies lowered limits to existing histories.
  trimHistories() {
    for (const node of this.root.topics()) this.trim(node);
  }

  find(topic) {
    let node = this.root;
    for (const level of topic.split('/')) {
      node = node.children.get(level);
      if (!node) return null;
    }
    return node;
  }

  // True when the node is still reachable from this tree's current root
  // (not removed, and not left over from before clear()).
  isAttached(node) {
    let n = node;
    for (; n.parent; n = n.parent) if (n.parent.children.get(n.name) !== n) return false;
    return n === this.root;
  }

  // Removes a node and everything below it.
  remove(node) {
    if (!node.parent || !this.isAttached(node)) return;
    for (let n = node.parent; n; n = n.parent) {
      n.subtreeMessages -= node.subtreeMessages;
      n.subtreeTopics -= node.subtreeTopics;
    }
    this.topicCount -= node.subtreeTopics;
    this.messageCount -= node.subtreeMessages;
    node.parent.children.delete(node.name);
    node.parent.sorted = null;
    // Drop now-empty ancestors so the tree does not keep dead branches.
    let p = node.parent;
    while (p.parent && p.children.size === 0 && p.messageCount === 0) {
      p.parent.children.delete(p.name);
      p.parent.sorted = null;
      p = p.parent;
    }
  }

  // Forgets the messages of one topic. The node stays if it has children.
  removeTopic(node) {
    if (!node.parent || !this.isAttached(node)) return;
    if (!node.children.size) return this.remove(node);
    if (!node.messageCount) return;
    for (let n = node; n; n = n.parent) {
      n.subtreeMessages -= node.messageCount;
      n.subtreeTopics -= 1;
    }
    this.topicCount -= 1;
    this.messageCount -= node.messageCount;
    node.messageCount = 0;
    node.message = null;
    node.history = [];
    node.historySize = 0;
    node.retained = false;
  }

  // What restore() needs to rebuild the tree elsewhere (structured-clone
  // friendly; the messages are shared, not copied): the topics with their
  // kept messages, and the expanded nodes. Topics come in the order of the
  // tree, so the rebuilt one lists them the same way.
  snapshot() {
    const topics = [];
    const expanded = [];
    const visit = (node) => {
      for (const n of node.children.values()) {
        if (n.messageCount) topics.push({ path: n.path, history: n.history.slice(), messageCount: n.messageCount, retained: n.retained, selfUpdate: n.selfUpdate });
        if (n.expanded) expanded.push(n.path);
        visit(n);
      }
    };
    visit(this.root);
    return { topics, expanded };
  }

  // Replaces the tree with a snapshot's, counting everything again; the
  // histories are trimmed to this tree's limits. lastUpdate becomes the
  // newest message in the subtree.
  restore({ topics, expanded }) {
    this.clear();
    for (const t of topics) {
      const node = this.nodeFor(t.path);
      node.history = t.history.slice();
      node.historySize = node.history.reduce((sum, m) => sum + m.payload.length, 0);
      this.trim(node);
      node.message = node.history[node.history.length - 1];
      node.messageCount = t.messageCount;
      node.selfUpdate = t.selfUpdate;
      node.retained = t.retained;
      for (let n = node; n; n = n.parent) {
        n.subtreeMessages += t.messageCount;
        n.subtreeTopics++;
        n.lastUpdate = Math.max(n.lastUpdate, t.selfUpdate);
      }
      this.topicCount++;
      this.messageCount += t.messageCount;
    }
    for (const path of expanded) {
      const node = this.find(path);
      if (node) node.expanded = true;
    }
  }

  setExpandedRecursive(node, expanded) {
    node.expanded = expanded;
    for (const child of node.children.values()) this.setExpandedRecursive(child, expanded);
  }

  // Flattens the tree into display rows. Without a filter only expanded
  // branches are walked; with one, every branch containing a match is shown.
  rows(filter) {
    const out = [];
    if (!filter) {
      const visit = (node, depth) => {
        for (const child of node.sortedChildren()) {
          out.push({ node: child, depth });
          if (child.expanded && child.children.size) visit(child, depth + 1);
        }
      };
      visit(this.root, 0);
      return out;
    }
    const visit = (node, depth) => {
      let any = false;
      for (const child of node.sortedChildren()) {
        const at = out.length;
        out.push({ node: child, depth });
        const self = filter(child);
        const below = child.children.size ? visit(child, depth + 1) : false;
        if (self || below) any = true;
        else out.length = at;
      }
      return any;
    };
    visit(this.root, 0);
    return out;
  }
}
