import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TopicTree, TopicNode } from '../../renderer/topicTree.js';
import { prng } from './_util.mjs';

let clock = 0;
const msg = (topic, size = 1, ts = ++clock) => ({ topic, payload: new Uint8Array(size), ts });

// Recomputes every derived count from scratch and compares with the tree.
function checkInvariants(tree) {
  const root = tree.root;
  assert.equal(root.parent, null);
  assert.equal(root.messageCount, 0, 'root never holds messages');
  assert.equal(root.path, '');
  const walk = (node) => {
    let msgs = node.messageCount;
    let topics = node.messageCount > 0 ? 1 : 0;
    for (const [key, child] of node.children) {
      assert.equal(child.name, key, 'children map key matches name');
      assert.equal(child.parent, node, `parent pointer of ${child.path}`);
      const expectedPath = node === root ? child.name : `${node.path}/${child.name}`;
      assert.equal(child.path, expectedPath);
      const sub = walk(child);
      msgs += sub.msgs;
      topics += sub.topics;
    }
    assert.equal(node.subtreeMessages, msgs, `subtreeMessages of "${node.path}"`);
    assert.equal(node.subtreeTopics, topics, `subtreeTopics of "${node.path}"`);
    if (node !== root && node.children.size === 0) assert.ok(node.messageCount > 0, `dead leaf "${node.path}"`);
    if (node.messageCount > 0) {
      assert.ok(node.history.length >= 1);
      assert.equal(node.history.at(-1), node.message, 'latest message is last in history');
      assert.ok(node.history.length <= Math.max(1, tree.historyLimit));
      assert.ok(node.history.length <= node.messageCount);
      assert.ok(node.historySize <= tree.historyBytes || node.history.length === 1, 'byte cap');
    } else {
      assert.equal(node.message, null);
      assert.equal(node.history.length, 0);
    }
    assert.equal(
      node.historySize,
      node.history.reduce((s, m) => s + m.payload.length, 0),
      `historySize of "${node.path}"`,
    );
    if (node.sorted) {
      assert.equal(node.sorted.length, node.children.size, 'stale sorted cache');
      for (const c of node.sorted) assert.equal(node.children.get(c.name), c, 'stale sorted cache entry');
    }
    return { msgs, topics };
  };
  const { msgs, topics } = walk(root);
  assert.equal(tree.messageCount, msgs, 'tree.messageCount');
  assert.equal(tree.topicCount, topics, 'tree.topicCount');
}

const allNodes = (tree) => {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children.values()) walk(c);
  };
  walk(tree.root);
  return out;
};

const names = (nodes) => nodes.map((n) => n.name);
const rowPaths = (rows) => rows.map((r) => `${r.depth}:${r.node.path}`);

describe('TopicTree.addMessage', () => {
  test('creates intermediate levels and counts topics/messages', () => {
    const t = new TopicTree();
    const n = t.addMessage(msg('a/b/c'));
    assert.ok(n instanceof TopicNode);
    assert.equal(n.path, 'a/b/c');
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    const a = t.find('a');
    const b = t.find('a/b');
    assert.equal(a.messageCount, 0);
    assert.equal(a.subtreeMessages, 1);
    assert.equal(a.subtreeTopics, 1);
    assert.equal(b.subtreeTopics, 1);
    assert.equal(t.root.subtreeMessages, 1);
    checkInvariants(t);
  });

  test('repeat messages on a topic count messages but not topics', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.addMessage(msg('a/b'));
    t.addMessage(msg('a'));
    assert.equal(t.topicCount, 2);
    assert.equal(t.messageCount, 3);
    const a = t.find('a');
    assert.equal(a.messageCount, 1);
    assert.equal(a.subtreeMessages, 3);
    assert.equal(a.subtreeTopics, 2);
    assert.equal(t.find('a/b').messageCount, 2);
    checkInvariants(t);
  });

  test('selfUpdate is per topic, lastUpdate propagates to every ancestor', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b', 1, 100));
    t.addMessage(msg('a/c', 1, 200));
    const a = t.find('a');
    const b = t.find('a/b');
    assert.equal(b.selfUpdate, 100);
    assert.equal(b.lastUpdate, 100);
    assert.equal(a.selfUpdate, 0, 'a has no messages of its own');
    assert.equal(a.lastUpdate, 200);
    assert.equal(t.root.lastUpdate, 200);
    t.addMessage(msg('a', 1, 300));
    assert.equal(a.selfUpdate, 300);
    assert.equal(b.lastUpdate, 100, 'siblings/children are not touched');
  });

  test('returns the node and keeps the latest message', () => {
    const t = new TopicTree();
    const m1 = msg('x');
    const m2 = msg('x');
    t.addMessage(m1);
    const n = t.addMessage(m2);
    assert.equal(n.message, m2);
    assert.deepEqual(n.history, [m1, m2]);
  });

  test('empty levels, leading slash and single-level topics', () => {
    const t = new TopicTree();
    t.addMessage(msg('a//b'));
    t.addMessage(msg('/a'));
    t.addMessage(msg('single'));
    t.addMessage(msg('a/'));
    assert.deepEqual(names(t.root.sortedChildren()).sort(), ['', 'a', 'single']);
    assert.equal(t.find('a//b').path, 'a//b');
    assert.equal(t.find('a/').path, 'a/');
    assert.equal(t.find('a/').messageCount, 1, '"a/" is a topic and also the parent of "a//b"');
    assert.equal(t.find('/a').path, '/a');
    assert.equal(t.find('/a').parent.name, '');
    assert.equal(t.find('/a').parent.path, '');
    assert.equal(t.find('single').path, 'single');
    assert.equal(t.topicCount, 4);
    checkInvariants(t);
  });
});

describe('history limits', () => {
  test('historyLimit keeps the newest N messages', () => {
    const t = new TopicTree({ historyLimit: 3 });
    const ms = Array.from({ length: 5 }, () => msg('a', 2));
    for (const m of ms) t.addMessage(m);
    const n = t.find('a');
    assert.deepEqual(n.history, ms.slice(2));
    assert.equal(n.historySize, 6);
    assert.equal(n.messageCount, 5, 'messageCount counts all received messages');
    checkInvariants(t);
  });

  test('historyBytes drops the oldest messages first', () => {
    const t = new TopicTree({ historyBytes: 10 });
    const ms = [msg('a', 4), msg('a', 4), msg('a', 4)];
    for (const m of ms) t.addMessage(m);
    const n = t.find('a');
    assert.deepEqual(n.history, ms.slice(1));
    assert.equal(n.historySize, 8);
    checkInvariants(t);
  });

  test('the latest message is always kept even if it alone exceeds the byte cap', () => {
    const t = new TopicTree({ historyBytes: 10 });
    const big = msg('a', 100);
    t.addMessage(msg('a', 3));
    t.addMessage(big);
    const n = t.find('a');
    assert.deepEqual(n.history, [big]);
    assert.equal(n.historySize, 100);
    const small = msg('a', 1);
    t.addMessage(small);
    assert.deepEqual(n.history, [small]);
    assert.equal(n.historySize, 1);
    checkInvariants(t);
  });

  test('historyLimit 0 or 1 still keeps the latest message', () => {
    for (const historyLimit of [0, 1]) {
      const t = new TopicTree({ historyLimit });
      t.addMessage(msg('a'));
      const last = msg('a');
      t.addMessage(last);
      assert.deepEqual(t.find('a').history, [last]);
      checkInvariants(t);
    }
  });

  test('zero-length payloads', () => {
    const t = new TopicTree({ historyBytes: 0, historyLimit: 5 });
    for (let i = 0; i < 4; i++) t.addMessage(msg('a', 0));
    assert.equal(t.find('a').history.length, 4);
    assert.equal(t.find('a').historySize, 0);
    checkInvariants(t);
  });

  test('defaults', () => {
    const t = new TopicTree();
    assert.equal(t.historyLimit, 100);
    assert.equal(t.historyBytes, 64 * 1024 * 1024);
  });
});

describe('find', () => {
  const t = new TopicTree();
  t.addMessage(msg('a/b/c'));
  t.addMessage(msg('/x'));
  test('finds topics and intermediate levels', () => {
    assert.equal(t.find('a/b/c').path, 'a/b/c');
    assert.equal(t.find('a/b').path, 'a/b');
    assert.equal(t.find('/x').path, '/x');
    assert.equal(t.find('').path, '', 'the empty first level exists because of "/x"');
  });
  test('missing topics are null', () => {
    assert.equal(t.find('a/b/c/d'), null);
    assert.equal(t.find('a/x'), null);
    assert.equal(t.find('b'), null);
    assert.equal(t.find('a//b'), null);
  });
});

describe('sortedChildren', () => {
  test('natural, case-insensitive order', () => {
    const t = new TopicTree();
    for (const n of ['robot-10', 'robot-2', 'robot-1', 'Alpha', 'beta', 'robot-100', '10', '9']) t.addMessage(msg(n));
    assert.deepEqual(names(t.root.sortedChildren()), ['9', '10', 'Alpha', 'beta', 'robot-1', 'robot-2', 'robot-10', 'robot-100']);
  });

  test('is cached and invalidated by adds and removes', () => {
    const t = new TopicTree();
    t.addMessage(msg('b'));
    t.addMessage(msg('c'));
    const first = t.root.sortedChildren();
    assert.equal(t.root.sortedChildren(), first, 'same array while unchanged');
    t.addMessage(msg('c')); // existing child: cache may stay
    assert.deepEqual(names(t.root.sortedChildren()), ['b', 'c']);
    t.addMessage(msg('a'));
    assert.deepEqual(names(t.root.sortedChildren()), ['a', 'b', 'c']);
    t.remove(t.find('b'));
    assert.deepEqual(names(t.root.sortedChildren()), ['a', 'c']);
  });

  test('pruning empty ancestors invalidates the grandparent cache', () => {
    const t = new TopicTree();
    t.addMessage(msg('x/y/z'));
    t.addMessage(msg('w'));
    assert.deepEqual(names(t.root.sortedChildren()), ['w', 'x']);
    t.remove(t.find('x/y/z'));
    assert.deepEqual(names(t.root.sortedChildren()), ['w']);
    checkInvariants(t);
  });
});

describe('remove', () => {
  test('restores counts exactly and prunes empty ancestors', () => {
    const t = new TopicTree();
    t.addMessage(msg('keep/me'));
    t.addMessage(msg('a/b/c/d'));
    t.addMessage(msg('a/b/c/d'));
    const d = t.find('a/b/c/d');
    t.remove(d);
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    assert.equal(t.find('a'), null, 'all empty ancestors pruned');
    assert.equal(t.root.subtreeMessages, 1);
    checkInvariants(t);
  });

  test('stops pruning at an ancestor that has messages or other children', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.addMessage(msg('a/b/c'));
    t.addMessage(msg('a/x/y'));
    t.addMessage(msg('a/x/z'));
    t.remove(t.find('a/b/c'));
    assert.ok(t.find('a'), 'a has a message');
    assert.equal(t.find('a/b'), null);
    t.remove(t.find('a/x/y'));
    assert.ok(t.find('a/x'), 'a/x still has child z');
    checkInvariants(t);
  });

  test('removing a subtree subtracts all of it', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.addMessage(msg('a/b/c'));
    t.addMessage(msg('a/b/c'));
    t.addMessage(msg('a/d'));
    t.remove(t.find('a/b'));
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    assert.equal(t.find('a').subtreeTopics, 1);
    assert.equal(t.find('a').subtreeMessages, 1);
    checkInvariants(t);
  });

  test('removing the root is a no-op', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.remove(t.root);
    assert.equal(t.topicCount, 1);
    checkInvariants(t);
  });

  test('removing an already-detached node is a no-op', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.addMessage(msg('c'));
    const b = t.find('a/b');
    t.remove(b);
    const snapshot = [t.topicCount, t.messageCount];
    t.remove(b);
    t.removeTopic(b);
    assert.deepEqual([t.topicCount, t.messageCount], snapshot);
    checkInvariants(t);
  });

  test('removing a node under a detached parent is a no-op', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b/c'));
    t.addMessage(msg('a/b'));
    t.addMessage(msg('z'));
    const c = t.find('a/b/c');
    t.remove(t.find('a'));
    assert.equal(t.isAttached(c), false);
    t.remove(c);
    t.removeTopic(c);
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    checkInvariants(t);
  });

  test('a stale node is a no-op even after the same topic is re-added', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    const old = t.find('a/b');
    t.remove(old);
    t.addMessage(msg('a/b'));
    t.remove(old);
    t.removeTopic(old);
    assert.equal(t.topicCount, 1);
    assert.ok(t.find('a/b'));
    checkInvariants(t);
  });

  test('nodes from before clear() are not attached', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    const stale = t.find('a/b');
    t.clear();
    assert.equal(t.isAttached(stale), false);
  });

  test('removing nodes from before clear() does not corrupt the new counts', () => {
    // e.g. deleteRetained() awaits a publish per node; the tree may be cleared meanwhile.
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.addMessage(msg('a/c'));
    t.addMessage(msg('a/c/d'));
    const stale = t.find('a/b');
    const staleWithChildren = t.find('a/c');
    t.clear();
    t.addMessage(msg('x'));
    t.remove(stale);
    t.removeTopic(staleWithChildren);
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    checkInvariants(t);
  });
});

describe('removeTopic', () => {
  test('a leaf topic is removed like remove()', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.addMessage(msg('a/b'));
    t.addMessage(msg('c'));
    t.removeTopic(t.find('a/b'));
    assert.equal(t.find('a'), null);
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    checkInvariants(t);
  });

  test('a topic with children keeps the node and its children, forgets its messages', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.addMessage(msg('a'));
    t.addMessage(msg('a/b'));
    const a = t.find('a');
    t.removeTopic(a);
    assert.equal(t.find('a'), a);
    assert.equal(a.messageCount, 0);
    assert.equal(a.message, null);
    assert.deepEqual(a.history, []);
    assert.equal(a.historySize, 0);
    assert.equal(a.subtreeMessages, 1);
    assert.equal(a.subtreeTopics, 1);
    assert.ok(t.find('a/b'));
    assert.equal(t.topicCount, 1);
    assert.equal(t.messageCount, 1);
    assert.deepEqual([...a.topics()].map((n) => n.path), ['a/b']);
    checkInvariants(t);
    // A new message makes it a topic again.
    t.addMessage(msg('a'));
    assert.equal(t.topicCount, 2);
    checkInvariants(t);
  });

  test('a message-less intermediate node is a no-op', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    t.removeTopic(t.find('a'));
    assert.ok(t.find('a/b'));
    assert.equal(t.topicCount, 1);
    checkInvariants(t);
  });

  test('removeTopic twice on a node with children does not double-subtract', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.addMessage(msg('a/b'));
    t.removeTopic(t.find('a'));
    t.removeTopic(t.find('a'));
    assert.equal(t.topicCount, 1);
    checkInvariants(t);
  });

  test('later removing the last child prunes the message-less parent', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.addMessage(msg('a/b'));
    t.removeTopic(t.find('a'));
    t.removeTopic(t.find('a/b'));
    assert.equal(t.find('a'), null);
    assert.equal(t.root.children.size, 0);
    assert.equal(t.topicCount, 0);
    assert.equal(t.messageCount, 0);
    checkInvariants(t);
  });

  test('root is a no-op', () => {
    const t = new TopicTree();
    t.addMessage(msg('a'));
    t.removeTopic(t.root);
    assert.equal(t.topicCount, 1);
  });
});

describe('isAttached', () => {
  test('root and live nodes are attached; removed nodes and their descendants are not', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b/c'));
    const a = t.find('a');
    const c = t.find('a/b/c');
    assert.equal(t.isAttached(t.root), true);
    assert.equal(t.isAttached(c), true);
    t.remove(a);
    assert.equal(t.isAttached(a), false);
    assert.equal(t.isAttached(c), false);
  });

  test('a free-standing node is not attached', () => {
    const t = new TopicTree();
    assert.equal(t.isAttached(new TopicNode('x', null)), false);
    assert.equal(t.isAttached(new TopicNode('x', new TopicNode('', null))), false);
  });
});

describe('setExpandedRecursive', () => {
  test('sets the flag on the node and every descendant only', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b/c'));
    t.addMessage(msg('a/d'));
    t.addMessage(msg('x/y'));
    t.setExpandedRecursive(t.find('a'), true);
    for (const p of ['a', 'a/b', 'a/b/c', 'a/d']) assert.equal(t.find(p).expanded, true, p);
    assert.equal(t.find('x').expanded, false);
    t.setExpandedRecursive(t.find('a/b'), false);
    assert.equal(t.find('a').expanded, true);
    assert.equal(t.find('a/b').expanded, false);
    assert.equal(t.find('a/b/c').expanded, false);
  });
});

describe('rows', () => {
  const build = () => {
    const t = new TopicTree();
    for (const p of ['b/x', 'a/y/z', 'a/y/w', 'a/k', 'c']) t.addMessage(msg(p));
    return t;
  };

  test('unfiltered: only top level when nothing is expanded', () => {
    assert.deepEqual(rowPaths(build().rows()), ['0:a', '0:b', '0:c']);
  });

  test('unfiltered: expanded branches are walked in sorted order with depth', () => {
    const t = build();
    t.find('a').expanded = true;
    assert.deepEqual(rowPaths(t.rows()), ['0:a', '1:a/k', '1:a/y', '0:b', '0:c']);
    t.find('a/y').expanded = true;
    assert.deepEqual(rowPaths(t.rows()), ['0:a', '1:a/k', '1:a/y', '2:a/y/w', '2:a/y/z', '0:b', '0:c']);
  });

  test('unfiltered: an expanded node under a collapsed parent stays hidden', () => {
    const t = build();
    t.find('a/y').expanded = true;
    assert.deepEqual(rowPaths(t.rows()), ['0:a', '0:b', '0:c']);
  });

  test('unfiltered: expanded leaves add nothing', () => {
    const t = build();
    t.find('c').expanded = true;
    assert.deepEqual(rowPaths(t.rows()), ['0:a', '0:b', '0:c']);
  });

  test('filtered: matches plus their ancestors, ignoring expansion state', () => {
    const t = build();
    const rows = t.rows((n) => n.name === 'z');
    assert.deepEqual(rowPaths(rows), ['0:a', '1:a/y', '2:a/y/z']);
  });

  test('filtered: non-matching children of a matching node are excluded', () => {
    const t = build();
    assert.deepEqual(rowPaths(t.rows((n) => n.path === 'a/y')), ['0:a', '1:a/y']);
  });

  test('filtered: several branches', () => {
    const t = build();
    const rows = t.rows((n) => n.messageCount > 0 && /[xkc]$/.test(n.path));
    assert.deepEqual(rowPaths(rows), ['0:a', '1:a/k', '0:b', '1:b/x', '0:c']);
  });

  test('filtered: no matches gives no rows', () => {
    assert.deepEqual(build().rows(() => false), []);
  });

  test('filtered: everything matches gives the full tree', () => {
    const t = build();
    assert.equal(t.rows(() => true).length, allNodes(t).length - 1);
  });

  test('the filter is called with nodes, never the root', () => {
    const t = build();
    const seen = [];
    t.rows((n) => (seen.push(n), false));
    assert.ok(!seen.includes(t.root));
    assert.equal(seen.length, allNodes(t).length - 1);
  });

  test('empty tree', () => {
    const t = new TopicTree();
    assert.deepEqual(t.rows(), []);
    assert.deepEqual(t.rows(() => true), []);
  });
});

describe('topics()', () => {
  test('yields every node with messages in the subtree, including self', () => {
    const t = new TopicTree();
    for (const p of ['a', 'a/b/c', 'a/b/d', 'x']) t.addMessage(msg(p));
    assert.deepEqual([...t.root.topics()].map((n) => n.path).sort(), ['a', 'a/b/c', 'a/b/d', 'x']);
    assert.deepEqual([...t.find('a').topics()].map((n) => n.path).sort(), ['a', 'a/b/c', 'a/b/d']);
    assert.deepEqual([...t.find('a/b').topics()].map((n) => n.path).sort(), ['a/b/c', 'a/b/d']);
    assert.deepEqual([...new TopicTree().root.topics()], []);
  });
});

describe('clear', () => {
  test('resets counts and root', () => {
    const t = new TopicTree();
    t.addMessage(msg('a/b'));
    const oldRoot = t.root;
    t.clear();
    assert.notEqual(t.root, oldRoot);
    assert.equal(t.topicCount, 0);
    assert.equal(t.messageCount, 0);
    assert.equal(t.find('a'), null);
    checkInvariants(t);
  });
});

describe('property: random add/remove/removeTopic sequences keep all counts consistent', () => {
  const LEVELS = ['a', 'b', 'c', '', 'robot-2', 'robot-10', '$SYS', 'A'];
  for (const seed of [1, 2, 3, 4]) {
    test(`seed ${seed}`, () => {
      const r = prng(seed);
      const t = new TopicTree({ historyLimit: r.int(1, 5), historyBytes: r.int(5, 40) });
      const model = new Map(); // topic -> live message count
      const everSeen = new Set();
      const pool = Array.from({ length: 60 }, () => Array.from({ length: r.int(1, 4) }, () => r.pick(LEVELS)).join('/'));
      const forget = (prefix) => {
        for (const k of [...model.keys()]) if (k === prefix || k.startsWith(prefix + '/')) model.delete(k);
      };
      for (let i = 0; i < 2500; i++) {
        const op = r.next();
        if (op < 0.6) {
          const topic = r.pick(pool);
          const n = t.addMessage(msg(topic, r.int(0, 12)));
          everSeen.add(n);
          model.set(topic, (model.get(topic) || 0) + 1);
        } else {
          const live = allNodes(t);
          // Mix live nodes with stale (possibly detached) references.
          const node = r.bool(0.75) ? r.pick(live) : r.pick([...everSeen]);
          if (!node) continue;
          const attached = t.isAttached(node);
          if (op < 0.8) {
            t.remove(node);
            if (attached && node.parent) {
              forget(node.path);
              assert.equal(t.isAttached(node), false, 'removed node is detached');
            }
          } else {
            const hadChildren = node.children.size > 0;
            const hadMessages = node.messageCount > 0;
            t.removeTopic(node);
            if (attached && node.parent) {
              if (!hadChildren) forget(node.path);
              else if (hadMessages) model.delete(node.path);
              assert.equal(t.isAttached(node), hadChildren, 'removeTopic keeps nodes with children');
            }
          }
          if (!attached) assert.equal(t.isAttached(node), false, 'detached nodes stay detached');
        }
        if (i % 25 === 0) checkInvariants(t);
        assert.equal(t.topicCount, model.size, `topicCount after op ${i}`);
        assert.equal(
          t.messageCount,
          [...model.values()].reduce((a, b) => a + b, 0),
          `messageCount after op ${i}`,
        );
      }
      checkInvariants(t);
      for (const [topic, count] of model) assert.equal(t.find(topic)?.messageCount, count, topic);
    });
  }
});

test('trimHistories applies lowered limits to existing histories and keeps sizes consistent', async () => {
  const fresh = await import('../../renderer/topicTree.js');
  const tree = new fresh.TopicTree({ historyLimit: 50, historyBytes: 1e9 });
  for (let i = 0; i < 40; i++) {
    tree.addMessage({ topic: 'a/b', payload: new Uint8Array(10), qos: 0, retain: false, ts: i });
    tree.addMessage({ topic: 'a/c', payload: new Uint8Array(100), qos: 0, retain: false, ts: i });
  }
  tree.historyLimit = 5;
  tree.historyBytes = 250;
  tree.trimHistories();
  const b = tree.find('a/b');
  const c = tree.find('a/c');
  assert.equal(b.history.length, 5);
  assert.equal(b.historySize, 50);
  assert.equal(c.history.length, 2);
  assert.equal(c.historySize, 200);
  assert.equal(b.history.at(-1).ts, 39, 'the newest messages are kept');
  assert.equal(b.messageCount, 40, 'counts are not affected');
});

test('retained flag: set by retained messages, cleared by an empty payload, reset by removeTopic', async () => {
  const fresh = await import('../../renderer/topicTree.js');
  const tree = new fresh.TopicTree();
  const add = (topic, payload, retain) => tree.addMessage({ topic, payload: new TextEncoder().encode(payload), qos: 0, retain, ts: 1 });
  add('x', 'live', false);
  assert.equal(tree.find('x').retained, false);
  add('x', 'kept', true);
  assert.equal(tree.find('x').retained, true);
  add('x', 'live again', false);
  assert.equal(tree.find('x').retained, true, 'a later live message does not clear it');
  add('x', '', false);
  assert.equal(tree.find('x').retained, false, 'an empty payload means the retained message was deleted');
  add('y', 'kept', true);
  add('y/z', 'kept', true);
  tree.removeTopic(tree.find('y'));
  assert.equal(tree.find('y').retained, false);
});
