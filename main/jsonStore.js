'use strict';

// Small named JSON documents (saved messages, plots, settings) kept in the
// app data directory. Writes are atomic.

const fs = require('node:fs');
const path = require('node:path');

// profileLayouts: the plot tabs of each profile (see layoutStore.js);
// plotTabs and plots: the plot tabs of every profile before 0.4.0, and the tab
// on screen in the 0.1 format (only read now); windowState: the windows and
// tabs to reopen; updates: the update version the user skipped.
const NAMES = new Set(['savedMessages', 'plots', 'plotTabs', 'profileLayouts', 'windowState', 'settings', 'updates']);

function createJsonStore(dir) {
  const fileFor = (name) => {
    if (!NAMES.has(name)) throw new Error(`Unknown store "${name}"`);
    return path.join(dir, `${name}.json`);
  };

  function get(name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && NAMES.has(name)) {
        try {
          fs.copyFileSync(fileFor(name), `${fileFor(name)}.corrupt-${Date.now()}`);
        } catch {}
      }
      if (!NAMES.has(name)) throw err;
      return fallback;
    }
  }

  function set(name, value) {
    const file = fileFor(name);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  }

  return { get, set };
}

module.exports = { createJsonStore };
