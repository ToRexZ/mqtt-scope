// Pop-out inspector window for one topic. Receives that topic's messages
// from the main process and keeps its own (longer) history.

import { MessageViewer } from './viewer.js';

const HISTORY_LIMIT = 500;
const HISTORY_BYTES = 64 * 1024 * 1024;
const api = window.api;

const init = await api.popoutInit();
if (init) {
  document.title = `${init.topic} — MQTT Scope`;
  const source = { path: init.topic, history: init.history || [], messageCount: (init.history || []).length };
  const viewer = new MessageViewer(document.querySelector('#viewer-host'), { api, standalone: true });
  viewer.show(source);
  let dirty = false;
  api.onMessages(({ messages }) => {
    for (const m of messages) {
      source.history.push(m);
      source.messageCount++;
    }
    let bytes = source.history.reduce((n, m) => n + m.payload.length, 0);
    while (source.history.length > 1 && (source.history.length > HISTORY_LIMIT || bytes > HISTORY_BYTES)) {
      bytes -= source.history.shift().payload.length;
    }
    dirty = true;
  });
  setInterval(() => {
    if (dirty) {
      dirty = false;
      viewer.update();
    }
  }, 150);
}
