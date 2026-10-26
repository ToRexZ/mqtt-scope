// Connection manager: a list of saved broker profiles and an editor for the
// selected one. Edits are saved automatically. One per window: the shell
// draws it in the active New connection tab (mount), and it shows that tab's
// connection status.

import { el, button, toast } from './ui.js';
import { comboFromEvent, isTypingTarget } from './keys.js';
import { DEFAULT_PORTS, blankProfile, parseSubscriptions, formatSubscriptions, newId } from './profiles.js';


export class ConnectionDialog {
  // opts: api, getBinding(id), onProfilesChanged() — the list was loaded,
  // reloaded or edited
  constructor(opts) {
    this.opts = opts;
    this.api = opts.api;
    this.profiles = [];
    this.selectedId = null;
    this.status = null;
    this.openIds = new Set(); // profiles open in a tab, in any window
    this.seenHosts = new WeakSet(); // the tabs it has been drawn in
    this.host = null; // the tab element it is drawn in
    this.mounted = null; // mount()'s options: closable, failed, onConnect(profile), onCancel()
    this.tabProfileId = undefined; // that tab's profile when last mounted
    this.box = el('div', 'conn-dialog');
    this.box.addEventListener('keydown', (e) => this.handleKey(e));
  }

  async load() {
    this.security = await this.api.profileSecurity().catch(() => null);
    this.profiles = await this.api.listProfiles();
    // One to start with, saved before it connects (main keeps plots only for
    // saved profiles).
    if (!this.profiles.length) {
      this.profiles = [blankProfile('Local broker')];
      this.dirty = true;
    }
    // Registered before the set is read, so no change falls between the two.
    this.api.onOpenProfilesChanged((ids) => this.setOpenProfiles(ids));
    this.setOpenProfiles(await this.api.openProfiles());
    this.selectedId = this.firstClosed().id;
    this.opts.onProfilesChanged?.();
  }

  // The first profile that is not open, else the first.
  firstClosed() {
    return this.profiles.find((p) => !this.openIds.has(p.id)) || this.profiles[0];
  }

  // Delete follows what is open, without redrawing the form.
  setOpenProfiles(ids) {
    this.openIds = new Set(ids);
    this.renderDelete();
  }

  renderDelete() {
    if (!this.deleteBtn) return;
    const open = this.openIds.has(this.selectedId);
    this.deleteBtn.disabled = open;
    this.deleteBtn.title = open ? 'Close its tab first' : 'Delete this connection';
  }

  // Picks up changes saved by another window, unless this one has unsaved edits.
  async reload() {
    if (this.dirty) return;
    this.profiles = await this.api.listProfiles();
    if (!this.profiles.some((p) => p.id === this.selectedId)) this.selectedId = this.profiles[0]?.id ?? null;
    if (this.host) this.render(this.box.contains(document.activeElement) ? 'list' : null);
    this.opts.onProfilesChanged?.();
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
    this.opts.onProfilesChanged?.();
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

  isMounted() {
    return !!this.host;
  }

  // Draws the dialog in `host`, the content of a New connection tab; mounting
  // in the same tab again takes the new options. The tab's profile is
  // selected when the dialog is drawn in it and when the tab gets another one
  // (Connect, or a tab reopened for its profile), not while the user browses
  // the list. opts: closable (× and Esc call onCancel), failed (the tab's last
  // attempt failed: Connect reads Retry for its profile), onConnect(profile),
  // onCancel(), profileId, focus (false leaves the focus where it is, e.g.
  // in a dialog over the window).
  mount(host, { profileId = null, focus = true, ...opts }) {
    const moved = this.host !== host;
    if (moved) {
      this.unmount();
      this.host = host;
      host.append(this.box);
    }
    this.mounted = opts;
    const select = profileId !== this.tabProfileId && profileId !== this.selectedId && this.profiles.some((p) => p.id === profileId);
    this.tabProfileId = profileId;
    if (select) this.selectedId = profileId;
    // A fresh picker starts on a profile it could connect, not one that is open.
    else if (moved && profileId == null && !this.seenHosts.has(host) && this.openIds.has(this.selectedId)) this.selectedId = this.firstClosed().id;
    this.seenHosts.add(host);
    if (moved) this.render(focus ? 'list' : null);
    else if (select) this.render(this.box.contains(document.activeElement) ? 'list' : null);
    else {
      this.renderClose();
      this.renderConnectLabel();
    }
  }

  // Its tab was hidden, closed or connected.
  unmount() {
    if (!this.host) return;
    this.flush();
    this.box.remove();
    this.host = null;
    this.mounted = null;
    this.tabProfileId = undefined;
  }

  // Mod+K in a New connection tab.
  focus() {
    this.box.querySelector('.conn-item.active')?.focus();
  }

  // × and Esc (the shell's, see app.js): closes its tab, unless that is the
  // window's only one. Returns whether it did.
  cancel() {
    if (!this.host || !this.mounted?.closable) return false;
    this.mounted.onCancel();
    return true;
  }

  // Enter (rebindable) connects; arrow keys move through the list.
  handleKey(e) {
    const t = e.target;
    const connectKey = this.opts.getBinding?.('connectSelected') ?? 'Enter';
    if (connectKey && comboFromEvent(e) === connectKey) {
      // Enter still adds lines to the subscription list and presses focused buttons.
      if (t.closest('textarea, select, button') || t.type === 'checkbox') return;
      e.preventDefault();
      this.connect();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isTypingTarget(t)) {
      e.preventDefault();
      const i = this.profiles.findIndex((p) => p.id === this.selectedId);
      const next = this.profiles[Math.max(0, Math.min(this.profiles.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next.id !== this.selectedId) {
        this.selectedId = next.id;
        this.render();
      }
    }
  }

  // The connection status of the tab it is drawn in.
  onStatus(status) {
    this.status = status;
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

  // focus: 'list' puts focus on the selected connection (so Enter connects),
  // 'name' on the name field (for a new connection), null leaves it.
  render(focus = 'list') {
    this.box.textContent = '';
    this.connectBtn = null;
    this.deleteBtn = null;
    const side = el('div', 'conn-list');
    const listHead = el('div', 'conn-list-head');
    listHead.append(
      el('span', 'pane-title', 'Connections'),
      button('+ New', 'Add a connection', () => {
        const p = blankProfile();
        this.profiles.push(p);
        this.selectedId = p.id;
        this.persist();
        this.render('name');
      }, 'btn small'),
    );
    side.append(listHead);
    for (const p of this.profiles) {
      const item = el('div', 'conn-item' + (p.id === this.selectedId ? ' active' : ''));
      item.tabIndex = p.id === this.selectedId ? 0 : -1;
      item.title = 'Double-click or press Enter to connect';
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

    this.box.append(side, form);
    this.renderClose();
    if (focus === 'name') form.querySelector('input[name="name"]')?.select();
    else if (focus === 'list') side.querySelector('.conn-item.active')?.focus();
  }

  // × only where the tab may be cancelled.
  renderClose() {
    const shown = this.box.querySelector(':scope > .modal-close');
    if (!this.mounted?.closable) return shown?.remove();
    if (!shown) this.box.append(button('×', 'Close this tab (Esc)', () => this.cancel(), 'btn icon modal-close'));
  }

  // Retry where the tab's last attempt with the selected profile failed.
  renderConnectLabel() {
    if (!this.connectBtn) return;
    const retry = !!this.mounted?.failed && this.selectedId === this.tabProfileId;
    this.connectBtn.textContent = retry ? 'Retry' : 'Connect';
    this.connectBtn.title = retry ? 'Try connecting to this broker again' : 'Connect to this broker';
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
      (this.deleteBtn = button('Delete', 'Delete this connection', () => this.remove(p), 'btn danger')),
      button('Duplicate', 'Copy this connection', () => {
        const copy = { ...structuredClone(p), id: newId(), name: `${p.name} (copy)` };
        this.profiles.push(copy);
        this.selectedId = copy.id;
        this.persist();
        this.render('name');
      }),
      el('span', 'spacer'),
      (this.connectBtn = button('Connect', 'Connect to this broker', () => this.connect(), 'btn primary connect-btn')),
    );
    form.append(el('h3', '', 'Connection'), grid, tlsBox, this.statusEl, actions);
    syncProtocol();
    this.renderStatus();
    this.renderConnectLabel();
    this.renderDelete();
  }

  refreshListItem(p) {
    const items = this.box.querySelectorAll('.conn-item');
    const i = this.profiles.indexOf(p);
    if (!items[i]) return;
    items[i].querySelector('.conn-name').textContent = p.name || '(unnamed)';
    items[i].querySelector('.conn-url').textContent = `${p.protocol}://${p.host}:${p.port}`;
  }

  async remove(p) {
    if (this.openIds.has(p.id)) return; // the button is disabled, but its tab may have opened since
    if (!(await this.api.confirm({ message: `Delete connection “${p.name}”?`, okLabel: 'Delete' }))) return;
    if (this.openIds.has(p.id)) return; // it was opened while the question showed
    this.profiles = this.profiles.filter((x) => x !== p);
    if (!this.profiles.length) this.profiles.push(blankProfile('Local broker'));
    this.selectedId = this.firstClosed().id;
    this.dirty = true;
    this.opts.onProfilesChanged?.();
    await this.flush();
    this.render();
  }

  // Connects the tab it is drawn in (taken now: the tab may change while the
  // edits are saved).
  async connect() {
    const p = this.selected;
    const target = this.mounted?.onConnect;
    if (!p || !target) return;
    if (!String(p.host || '').trim()) return toast('Host is required', 'error');
    await this.flush();
    target(p);
  }
}
