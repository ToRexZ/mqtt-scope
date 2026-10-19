// Connection manager: a list of saved broker profiles and an editor for the
// selected one. Edits are saved automatically.

import { el, button, toast } from './ui.js';
import { DEFAULT_PORTS, blankProfile, parseSubscriptions, formatSubscriptions, newId } from './profiles.js';


export class ConnectionDialog {
  // opts: api, onConnect(profile)
  constructor(opts) {
    this.opts = opts;
    this.api = opts.api;
    this.profiles = [];
    this.selectedId = null;
    this.status = null;
  }

  async load() {
    this.security = await this.api.profileSecurity().catch(() => null);
    this.profiles = await this.api.listProfiles();
    if (!this.profiles.length) this.profiles = [blankProfile('Local broker')];
    this.selectedId = this.profiles[0].id;
  }

  // Picks up changes saved by another window, unless this one has unsaved edits.
  async reload() {
    if (this.dirty) return;
    this.profiles = await this.api.listProfiles();
    if (!this.profiles.some((p) => p.id === this.selectedId)) this.selectedId = this.profiles[0]?.id ?? null;
    if (this.overlay) this.render();
  }

  setSubscriptions(id, subs) {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return;
    p.subscriptions = subs.map((s) => ({ topic: s.topic, qos: s.qos }));
    this.persist();
  }

  get selected() {
    return this.profiles.find((p) => p.id === this.selectedId) || null;
  }

  persist() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  // Writes only when something changed, so closing the app never rewrites
  // profiles it merely loaded.
  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.api.saveProfiles(this.profiles);
    } catch (err) {
      toast(`Could not save connections: ${err.message}`, 'error');
    }
  }

  isOpen() {
    return !!this.overlay;
  }

  open() {
    if (this.overlay) return;
    this.overlay = el('div', 'modal-overlay');
    this.box = el('div', 'modal conn-dialog');
    this.overlay.append(this.box);
    document.body.append(this.overlay);
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.render();
  }

  close() {
    this.flush();
    this.overlay?.remove();
    this.overlay = null;
  }

  onStatus(status) {
    this.status = status;
    if (!this.overlay) return;
    if (status.state === 'connected') return this.close();
    this.renderStatus();
  }

  renderStatus() {
    if (!this.statusEl) return;
    const s = this.status;
    this.statusEl.className = `conn-status-line ${s?.state || ''}`;
    if (!s || s.state === 'disconnected') this.statusEl.textContent = '';
    else if (s.state === 'error') this.statusEl.textContent = `Error: ${s.error}`;
    else this.statusEl.textContent = `${s.state[0].toUpperCase()}${s.state.slice(1)}… ${s.url || ''}`;
  }

  render() {
    this.box.textContent = '';
    const side = el('div', 'conn-list');
    const listHead = el('div', 'conn-list-head');
    listHead.append(
      el('span', 'pane-title', 'Connections'),
      button('+ New', 'Add a connection', () => {
        const p = blankProfile();
        this.profiles.push(p);
        this.selectedId = p.id;
        this.persist();
        this.render();
      }, 'btn small'),
    );
    side.append(listHead);
    for (const p of this.profiles) {
      const item = el('div', 'conn-item' + (p.id === this.selectedId ? ' active' : ''));
      item.append(el('div', 'conn-name', p.name || '(unnamed)'), el('div', 'conn-url', `${p.protocol}://${p.host}:${p.port}`));
      item.addEventListener('click', () => {
        this.selectedId = p.id;
        this.render();
      });
      item.addEventListener('dblclick', () => this.connect());
      side.append(item);
    }

    const form = el('div', 'conn-form');
    const p = this.selected;
    if (p) this.renderForm(form, p);

    const close = button('×', 'Close (Esc)', () => this.close(), 'btn icon modal-close');
    this.box.append(side, form, close);
  }

  renderForm(form, p) {
    const field = (label, input, hint) => {
      const wrap = el('label', 'field');
      wrap.append(el('span', 'field-label', label), input);
      if (hint) wrap.append(el('span', 'field-hint', hint));
      return wrap;
    };
    const text = (key, placeholder = '', type = 'text') => {
      const i = el('input', 'input');
      i.type = type;
      i.value = p[key] ?? '';
      i.placeholder = placeholder;
      i.spellcheck = false;
      i.name = key;
      i.addEventListener('input', () => {
        p[key] = type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value;
        if (key === 'password') delete p.passwordLost; // a new password replaces the unreadable one
        if (key === 'name' || key === 'host' || key === 'port') this.refreshListItem(p);
        this.persist();
      });
      return i;
    };
    const select = (key, options, onChange) => {
      const s = el('select', 'select');
      s.name = key;
      for (const [v, l] of options) s.append(Object.assign(el('option', '', l), { value: String(v) }));
      s.value = String(p[key]);
      s.addEventListener('change', () => {
        const old = p[key];
        p[key] = typeof old === 'number' ? Number(s.value) : s.value;
        onChange?.(old, p[key]);
        this.persist();
      });
      return s;
    };
    const check = (key, label) => {
      const wrap = el('label', 'check');
      const c = el('input');
      c.type = 'checkbox';
      c.name = key;
      c.checked = p[key] !== false;
      c.addEventListener('change', () => {
        p[key] = c.checked;
        this.persist();
      });
      wrap.append(c, document.createTextNode(` ${label}`));
      return wrap;
    };
    const fileField = (key, label) => {
      const row = el('div', 'file-row');
      const i = text(key, 'Path to PEM file');
      row.append(
        i,
        button('Browse…', '', async () => {
          const f = await this.api.pickFile(label);
          if (f) {
            i.value = f;
            p[key] = f;
            this.persist();
          }
        }),
      );
      return field(label, row);
    };

    const portInput = text('port', '1883', 'number');
    const wsRow = field('WebSocket path', text('wsPath', '/mqtt'));
    const tlsBox = el('fieldset', 'tls');
    tlsBox.append(
      el('legend', '', 'TLS'),
      check('rejectUnauthorized', 'Verify server certificate'),
      fileField('caFile', 'CA certificate'),
      fileField('certFile', 'Client certificate'),
      fileField('keyFile', 'Client key'),
    );
    const syncProtocol = () => {
      wsRow.hidden = !p.protocol.startsWith('ws');
      tlsBox.hidden = !(p.protocol === 'mqtts' || p.protocol === 'wss');
    };
    const protocol = select(
      'protocol',
      [
        ['mqtt', 'mqtt:// (TCP)'],
        ['mqtts', 'mqtts:// (TLS)'],
        ['ws', 'ws:// (WebSocket)'],
        ['wss', 'wss:// (WebSocket + TLS)'],
      ],
      (oldProto, newProto) => {
        if (Number(p.port) === DEFAULT_PORTS[oldProto] || !p.port) {
          p.port = DEFAULT_PORTS[newProto];
          portInput.value = p.port;
          this.refreshListItem(p);
        }
        syncProtocol();
      },
    );

    const subs = el('textarea', 'input subs');
    subs.name = 'subscriptions';
    subs.rows = 3;
    subs.spellcheck = false;
    subs.value = formatSubscriptions(p.subscriptions);
    subs.addEventListener('input', () => {
      p.subscriptions = parseSubscriptions(subs.value);
      this.persist();
    });

    const password = text('password', '', 'password');
    const showPw = button('Show', 'Show password', () => {
      password.type = password.type === 'password' ? 'text' : 'password';
      showPw.textContent = password.type === 'password' ? 'Show' : 'Hide';
    }, 'btn small');
    const pwRow = el('div', 'file-row');
    pwRow.append(password, showPw);

    const grid = el('div', 'form-grid');
    grid.append(
      field('Name', text('name', 'My broker')),
      field('Protocol', protocol),
      field('Host', text('host', 'broker.example.com')),
      field('Port', portInput),
      wsRow,
      field('MQTT version', select('mqttVersion', [
        [4, '3.1.1'],
        [5, '5.0'],
      ])),
      field('Username', text('username')),
      field('Password', pwRow, p.passwordLost ? 'The stored password could not be decrypted (is the system keyring unlocked?). Enter it again or leave it to keep the stored one.' : this.security && !this.security.secure ? 'No system keyring available: passwords are stored without real encryption in the app data folder.' : ''),
      field('Client ID', text('clientId', 'Random when empty')),
      field('Keep-alive (s)', text('keepalive', '60', 'number')),
    );
    const subsField = field('Subscriptions', subs, 'One topic filter per line, optional QoS after a space. # subscribes to everything.');
    subsField.classList.add('wide');
    grid.append(subsField, check('clean', 'Clean session'));

    this.statusEl = el('div', 'conn-status-line');
    const actions = el('div', 'modal-actions');
    actions.append(
      button('Delete', 'Delete this connection', () => this.remove(p), 'btn danger'),
      button('Duplicate', 'Copy this connection', () => {
        const copy = { ...structuredClone(p), id: newId(), name: `${p.name} (copy)` };
        this.profiles.push(copy);
        this.selectedId = copy.id;
        this.persist();
        this.render();
      }),
      el('span', 'spacer'),
      button('Connect', 'Connect to this broker', () => this.connect(), 'btn primary connect-btn'),
    );
    form.append(el('h3', '', 'Connection'), grid, tlsBox, this.statusEl, actions);
    syncProtocol();
    this.renderStatus();
  }

  refreshListItem(p) {
    const items = this.box.querySelectorAll('.conn-item');
    const i = this.profiles.indexOf(p);
    if (!items[i]) return;
    items[i].querySelector('.conn-name').textContent = p.name || '(unnamed)';
    items[i].querySelector('.conn-url').textContent = `${p.protocol}://${p.host}:${p.port}`;
  }

  async remove(p) {
    if (!(await this.api.confirm({ message: `Delete connection “${p.name}”?`, okLabel: 'Delete' }))) return;
    this.profiles = this.profiles.filter((x) => x !== p);
    if (!this.profiles.length) this.profiles.push(blankProfile('Local broker'));
    this.selectedId = this.profiles[0].id;
    this.dirty = true;
    await this.flush();
    this.render();
  }

  async connect() {
    const p = this.selected;
    if (!p) return;
    if (!String(p.host || '').trim()) return toast('Host is required', 'error');
    await this.flush();
    this.opts.onConnect(p);
  }
}
