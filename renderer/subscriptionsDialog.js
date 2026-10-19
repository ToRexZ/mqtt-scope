// Subscriptions of the live connection: add or remove topic filters without
// reconnecting, optionally saving the change to the connection profile.

import { el, button, toast } from './ui.js';

// opts: api, profileName, onSaved(subscriptions) — called with the new list
// when "Save to connection" is ticked.
export async function openSubscriptions(opts) {
  const { api } = opts;
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal prompt subs-dialog');
  const list = el('div', 'subs-list');
  const filter = Object.assign(el('input', 'input subs-filter'), { placeholder: 'Topic filter, e.g. robots/+/state or #', spellcheck: false });
  const qos = el('select', 'select');
  for (const q of [0, 1, 2]) qos.append(Object.assign(el('option', '', `QoS ${q}`), { value: String(q) }));
  const saveBox = Object.assign(el('input'), { type: 'checkbox', checked: true });
  const saveLabel = el('label', 'check small');
  saveLabel.append(saveBox, document.createTextNode(` Save changes to “${opts.profileName || 'this connection'}”`));
  const status = el('div', 'field-hint');

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());

  const saved = async () => {
    if (saveBox.checked) opts.onSaved?.(await api.subscriptions());
  };

  const render = async () => {
    const subs = await api.subscriptions();
    list.textContent = '';
    if (!subs.length) list.append(el('div', 'placeholder small', 'No subscriptions: nothing will arrive.'));
    for (const s of subs) {
      const row = el('div', 'subs-row');
      row.append(
        el('span', 'subs-topic', s.topic),
        el('span', 'subs-qos', `QoS ${s.qos}`),
        button('Unsubscribe', `Stop receiving ${s.topic}`, async () => {
          const res = await api.unsubscribe(s.topic);
          if (!res.ok) return toast(`Unsubscribe failed: ${res.error}`, 'error');
          await saved();
          render();
        }, 'btn small'),
      );
      list.append(row);
    }
  };

  const add = async () => {
    const topic = filter.value.trim();
    if (!topic) return filter.focus();
    status.textContent = 'Subscribing…';
    const res = await api.subscribe(topic, Number(qos.value));
    if (!res.ok) {
      status.textContent = `Not subscribed: ${res.error}`;
      status.classList.add('bad');
      return;
    }
    status.textContent = '';
    status.classList.remove('bad');
    filter.value = '';
    await saved();
    render();
  };

  const addRow = el('form', 'subs-add');
  addRow.append(filter, qos, Object.assign(el('button', 'btn primary', 'Subscribe'), { type: 'submit' }));
  addRow.addEventListener('submit', (e) => {
    e.preventDefault();
    add();
  });
  const actions = el('div', 'modal-actions');
  actions.append(saveLabel, el('span', 'spacer'), button('Close', '', close));
  box.append(
    el('h3', '', 'Subscriptions'),
    el('div', 'field-hint', 'Changes apply immediately to the live connection. Topics already in the tree stay until you clear it.'),
    list,
    addRow,
    status,
    actions,
  );
  overlay.append(box);
  document.body.append(overlay);
  await render();
  filter.focus();
}
