// Publisher: compose and send messages, plus a library of saved messages
// (named topic + payload + options) and a list of recent publishes.

import { el, button, toast, promptText } from './ui.js';
import { iconButton, setIcon } from './icons.js';
import { decode, parseHex, formatTime, unsafeJson, hasUnsafeIntegers } from './payload.js';

const RECENT_LIMIT = 50;
const newId = () => Math.random().toString(36).slice(2, 10);
let instances = 0; // each connection tab has a publisher; their topic lists need distinct ids

export class Publisher {
  // opts: api, getTopics(prefix) -> string[], onToggle(collapsed)
  constructor(host, opts) {
    this.opts = opts;
    this.api = opts.api;
    this.saved = [];
    this.recent = [];
    this.listMode = 'saved';
    this.thisTopicOnly = false;
    this.follow = true; // topic follows the tree selection until the message is edited
    this.busy = false;
    this.build(host);
  }

  build(host) {
    this.root = el('div', 'publisher');
    const head = el('div', 'pane-head pub-head');
    this.collapseBtn = iconButton('chevron-down', 'Collapse publisher', () => this.toggleCollapsed());
    head.append(el('span', 'pane-title', 'Publish'), el('span', 'spacer'), this.collapseBtn);

    const row1 = el('div', 'pub-row');
    this.topic = el('input', 'input topic-input');
    this.topic.placeholder = 'Topic to publish to';
    this.topic.spellcheck = false;
    this.topicList = el('datalist');
    this.topicList.id = `pub-topics-${++instances}`;
    this.topic.setAttribute('list', this.topicList.id);
    this.topic.addEventListener('input', () => {
      this.setFollow(false);
      this.fillTopicList();
      this.renderList();
    });
    this.followBtn = button('Follow tree', 'Fill the topic from the topic selected in the tree. Turns off when you edit the message.', () => {
      this.setFollow(!this.follow);
      if (this.follow) {
        const t = this.opts.getSelectedTopic?.();
        if (t) this.setTopic(t);
      }
    });
    this.qos = el('select', 'select');
    for (const q of [0, 1, 2]) this.qos.append(Object.assign(el('option', '', `QoS ${q}`), { value: String(q) }));
    const retainLabel = el('label', 'check');
    this.retain = el('input');
    this.retain.type = 'checkbox';
    retainLabel.append(this.retain, document.createTextNode(' Retain'));
    this.sendBtn = button('Publish', 'Publish', () => this.publish(), 'btn primary');
    row1.append(this.topic, this.topicList, this.followBtn, this.qos, retainLabel, this.sendBtn);

    const row2 = el('div', 'pub-row');
    this.format = el('select', 'select');
    for (const [v, l] of [
      ['json', 'JSON'],
      ['text', 'Text'],
      ['hex', 'Hex bytes'],
    ]) {
      this.format.append(Object.assign(el('option', '', l), { value: v }));
    }
    this.format.addEventListener('change', () => this.validate());
    this.validity = el('span', 'validity');
    row2.append(
      this.format,
      button('Format', 'Pretty-print JSON', () => this.prettify()),
      button('Minify', 'Compact JSON', () => this.prettify(true)),
      this.validity,
      el('span', 'spacer'),
      button('Load file…', 'Use a file as the payload', () => this.loadFile()),
      button('Save…', 'Save topic, payload and options to the library', () => this.saveCurrent(), 'btn'),
    );

    const body = el('div', 'pub-body');
    this.payload = el('textarea', 'payload-editor');
    this.payload.spellcheck = false;
    this.payload.placeholder = 'Payload — JSON, text or hex bytes depending on the format above';
    this.payload.addEventListener('input', () => {
      this.setFollow(false);
      clearTimeout(this.validateTimer);
      this.validateTimer = setTimeout(() => this.validate(), 200);
    });
    this.payload.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });

    const side = el('div', 'pub-library');
    const tabs = el('div', 'lib-tabs');
    this.savedTab = button('Saved', 'Saved messages', () => this.setListMode('saved'), 'tab');
    this.recentTab = button('Recent', 'Recently published', () => this.setListMode('recent'), 'tab');
    const onlyLabel = el('label', 'check small');
    this.onlyBox = el('input');
    this.onlyBox.type = 'checkbox';
    this.onlyBox.addEventListener('change', () => {
      this.thisTopicOnly = this.onlyBox.checked;
      this.renderList();
    });
    onlyLabel.append(this.onlyBox, document.createTextNode(' This topic only'));
    tabs.append(this.savedTab, this.recentTab, el('span', 'spacer'), onlyLabel);
    this.list = el('div', 'lib-list');
    side.append(tabs, this.list);
    body.append(this.payload, side);

    this.root.append(head, row1, row2, body);
    host.append(this.root);
    this.validate();
    this.setFollow(true);
    this.setListMode('saved');
  }

  // The tab closed: nothing of it may run later.
  dispose() {
    clearTimeout(this.validateTimer);
    this.root.remove();
  }

  setFollow(on) {
    this.follow = on;
    this.followBtn.classList.toggle('on', on);
  }

  async load() {
    try {
      const doc = await this.api.storeGet('savedMessages');
      if (doc) {
        this.saved = Array.isArray(doc.saved) ? doc.saved : [];
        this.recent = Array.isArray(doc.recent) ? doc.recent : [];
      }
    } catch (err) {
      toast(`Could not load saved messages: ${err.message}`, 'error');
    }
    this.renderList();
  }

  persist() {
    return this.api
      .storeSet('savedMessages', { saved: this.saved, recent: this.recent })
      .catch((err) => toast(`Could not save messages: ${err.message}`, 'error'));
  }

  toggleCollapsed(force) {
    const collapsed = force ?? !this.root.classList.contains('collapsed');
    this.root.classList.toggle('collapsed', collapsed);
    setIcon(this.collapseBtn, collapsed ? 'chevron-up' : 'chevron-down');
    this.collapseBtn.title = collapsed ? 'Expand publisher' : 'Collapse publisher';
    this.collapseBtn.setAttribute('aria-label', this.collapseBtn.title);
    this.opts.onToggle?.(collapsed);
  }

  fillTopicList() {
    this.topicList.textContent = '';
    for (const t of this.opts.getTopics(this.topic.value).slice(0, 200)) {
      const o = el('option');
      o.value = t;
      this.topicList.append(o);
    }
  }

  // Called when a topic is selected in the tree. Ignored once the user has
  // edited the message, so a composed command never silently changes target.
  setTopic(topic) {
    if (!this.follow) return;
    if (topic !== this.topic.value) this.retain.checked = false;
    this.topic.value = topic;
    this.renderList();
  }

  // Explicit "publish to this topic" from a menu: always applies.
  useTopic(topic) {
    if (topic !== this.topic.value) this.retain.checked = false;
    this.topic.value = topic;
    this.setFollow(false);
    this.toggleCollapsed(false);
    this.renderList();
    this.topic.focus();
  }

  // Loads a received message for editing.
  loadMessage(topic, msg) {
    const d = decode(msg);
    this.topic.value = topic;
    this.qos.value = String(msg.qos || 0);
    // Never carry the retain flag over: re-publishing a retained command by
    // accident would replay it to every client that connects later.
    this.retain.checked = false;
    this.setFollow(false);
    if (d.kind === 'binary') {
      this.format.value = 'hex';
      this.payload.value = Array.from(msg.payload, (b) => b.toString(16).padStart(2, '0')).join(' ');
    } else if (d.kind === 'json') {
      this.format.value = 'json';
      // Pretty-printing goes through JSON.parse, which rounds huge integers;
      // keep the exact text in that case.
      if (unsafeJson(d)) {
        this.payload.value = d.text;
        toast('Loaded as received: the message has integers too large to reformat without rounding', 'error');
      } else {
        this.payload.value = JSON.stringify(d.value, null, 2);
      }
    } else {
      this.format.value = 'text';
      this.payload.value = d.text;
    }
    this.toggleCollapsed(false);
    this.validate();
    this.renderList();
    this.payload.focus();
  }

  loadEntry(entry) {
    this.setFollow(false);
    this.topic.value = entry.topic;
    this.payload.value = entry.payload;
    this.format.value = entry.format || 'text';
    this.qos.value = String(entry.qos || 0);
    this.retain.checked = !!entry.retain;
    this.validate();
    this.renderList();
  }

  current() {
    return {
      topic: this.topic.value.trim(),
      payload: this.payload.value,
      format: this.format.value,
      qos: Number(this.qos.value),
      retain: this.retain.checked,
    };
  }

  // Returns { ok, error }.
  validate() {
    const { payload, format } = this.current();
    let res = { ok: true };
    if (format === 'json' && payload.trim()) {
      try {
        JSON.parse(payload);
        this.validity.textContent = '✓ valid JSON';
      } catch (err) {
        res = { ok: false, error: `Invalid JSON: ${err.message}` };
        this.validity.textContent = `✗ ${err.message}`;
      }
    } else if (format === 'hex') {
      try {
        this.validity.textContent = `${parseHex(payload).length} bytes`;
      } catch (err) {
        res = { ok: false, error: err.message };
        this.validity.textContent = `✗ ${err.message}`;
      }
    } else {
      this.validity.textContent = '';
    }
    this.validity.classList.toggle('bad', !res.ok);
    return res;
  }

  prettify(minify = false) {
    if (hasUnsafeIntegers(this.payload.value)) {
      toast('Not reformatted: the JSON has integers too large to reformat without rounding', 'error');
      return;
    }
    try {
      const v = JSON.parse(this.payload.value);
      this.payload.value = minify ? JSON.stringify(v) : JSON.stringify(v, null, 2);
      this.format.value = 'json';
      this.validate();
    } catch (err) {
      toast(`Not valid JSON: ${err.message}`, 'error');
    }
  }

  async loadFile() {
    const file = await this.api.readFileBytes();
    if (!file) return;
    const d = decode({ payload: file.bytes });
    if (d.kind === 'binary') {
      this.format.value = 'hex';
      this.payload.value = Array.from(file.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    } else {
      this.format.value = d.kind === 'json' ? 'json' : 'text';
      this.payload.value = d.text;
    }
    this.validate();
    toast(`Loaded ${file.name}`);
  }

  // Publishes one message. Only one publish runs at a time, so double clicks
  // or a held shortcut cannot send a command twice.
  async send(entry) {
    if (this.busy) return false;
    this.busy = true;
    this.sendBtn.disabled = true;
    try {
      return await this.sendNow(entry);
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
    }
  }

  async sendNow(entry) {
    if (entry.retain) {
      const ok = await this.api.confirm({
        message: `Publish a retained message to ${entry.topic}?`,
        detail: 'The broker keeps it and delivers it to every client that subscribes later, including after reconnects.',
        okLabel: 'Publish retained',
      });
      if (!ok) return false;
    }
    let body = entry.payload;
    if (entry.format === 'hex') {
      try {
        body = parseHex(entry.payload);
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    } else if (entry.format === 'json' && entry.payload.trim()) {
      try {
        JSON.parse(entry.payload);
      } catch (err) {
        toast(`Invalid JSON — fix it or switch the format to Text: ${err.message}`, 'error');
        return false;
      }
    }
    const res = await this.api.publish({ topic: entry.topic, payload: body, qos: entry.qos, retain: entry.retain });
    if (!res.ok) {
      toast(`Publish failed: ${res.error}`, 'error');
      return false;
    }
    this.recent = [{ ...entry, ts: Date.now() }, ...this.recent.filter((r) => !sameMessage(r, entry))].slice(0, RECENT_LIMIT);
    this.persist();
    if (this.listMode === 'recent') this.renderList();
    toast(`Published to ${entry.topic}`);
    return true;
  }

  publish() {
    return this.send(this.current());
  }

  async saveCurrent() {
    const cur = this.current();
    if (!cur.topic) return toast('Enter a topic first', 'error');
    const existing = this.saved.find((s) => s.topic === cur.topic && s.payload === cur.payload);
    const name = await promptText({
      title: 'Save message',
      label: `Name for this message on ${cur.topic}`,
      value: existing?.name || cur.topic.split('/').pop(),
      okLabel: 'Save',
    });
    if (!name) return;
    const same = this.saved.find((s) => s.topic === cur.topic && s.name === name);
    if (same) Object.assign(same, cur, { updatedAt: Date.now() });
    else this.saved.push({ id: newId(), name, ...cur, updatedAt: Date.now() });
    await this.persist();
    this.setListMode('saved');
    toast(`Saved “${name}”`);
  }

  setListMode(mode) {
    this.listMode = mode;
    this.savedTab.classList.toggle('active', mode === 'saved');
    this.recentTab.classList.toggle('active', mode === 'recent');
    this.renderList();
  }

  renderList() {
    const topic = this.topic.value.trim();
    let items = this.listMode === 'saved' ? [...this.saved] : [...this.recent];
    if (this.thisTopicOnly) items = items.filter((i) => i.topic === topic);
    else if (this.listMode === 'saved') {
      // Messages for the current topic first, then by name.
      items.sort((a, b) => (b.topic === topic) - (a.topic === topic) || a.topic.localeCompare(b.topic) || a.name.localeCompare(b.name));
    }
    this.list.textContent = '';
    if (!items.length) {
      const hint =
        this.listMode === 'saved'
          ? this.thisTopicOnly
            ? 'No saved messages for this topic'
            : 'Nothing saved yet. Compose a message and click “Save…”.'
          : 'Nothing published yet';
      this.list.append(el('div', 'placeholder small', hint));
      return;
    }
    for (const item of items) {
      const row = el('div', 'lib-item' + (item.topic === topic ? ' match' : ''));
      const text = el('div', 'lib-text');
      const title = this.listMode === 'saved' ? item.name : formatTime(item.ts);
      text.append(el('div', 'lib-name', title), el('div', 'lib-topic', item.topic), el('div', 'lib-preview', item.payload.replace(/\s+/g, ' ').slice(0, 120)));
      text.title = 'Click to load into the editor';
      text.addEventListener('click', () => this.loadEntry(item));
      const actions = el('div', 'lib-actions');
      actions.append(button('▶', `Publish to ${item.topic} now`, () => this.send(item), 'btn icon send'));
      if (this.listMode === 'saved') {
        actions.append(
          button('✎', 'Rename', async () => {
            const name = await promptText({ title: 'Rename saved message', label: 'Name', value: item.name });
            if (name) {
              item.name = name;
              this.persist();
              this.renderList();
            }
          }, 'btn icon'),
          iconButton('trash', 'Delete', async () => {
            if (!(await this.api.confirm({ message: `Delete saved message “${item.name}”?`, okLabel: 'Delete' }))) return;
            this.saved = this.saved.filter((s) => s !== item);
            this.persist();
            this.renderList();
          }, 'btn icon'),
        );
      } else {
        actions.append(
          button('★', 'Save to library', () => {
            this.loadEntry(item);
            this.saveCurrent();
          }, 'btn icon'),
        );
      }
      row.append(text, actions);
      this.list.append(row);
    }
  }
}

const sameMessage = (a, b) => a.topic === b.topic && a.payload === b.payload && a.format === b.format && a.qos === b.qos && a.retain === b.retain;
