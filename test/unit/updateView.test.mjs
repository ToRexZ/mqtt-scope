// What the top-bar update button, its panel and the Installing dialog show
// for each UpdateState (renderer/updateView.js). The DOM side
// (renderer/updateButton.js) only draws these and sends the intents; see
// test/e2e/updates.spec.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SELF_UPDATING_KINDS, buttonView, panelView, installingView, checkedView } from '../../renderer/updateView.js';
import { requireFromRoot } from './_util.mjs';

const { SELF_UPDATING } = requireFromRoot('./main/updateCheck.js');

const state = (patch = {}) => ({
  status: 'available',
  current: '0.3.0',
  kind: 'appimage',
  latest: { version: '0.3.1', notes: 'Fixed things' },
  progress: null,
  error: null,
  pacmanCommand: null,
  ...patch,
});
const ids = (items) => items.map((i) => i.id);
const labels = (items) => items.map((i) => i.label);

describe('buttonView', () => {
  test('hidden while there is nothing to offer', () => {
    assert.equal(buttonView(state({ status: 'none', latest: null })), null);
    assert.equal(buttonView(null), null);
    assert.equal(buttonView(undefined), null);
  });

  test('one label per status; once downloaded it restarts instead of opening the panel', () => {
    assert.deepEqual(buttonView(state()), { icon: '↑', text: 'Update 0.3.1', tone: 'available', click: 'panel' });
    assert.deepEqual(buttonView(state({ status: 'downloading', progress: 42 })), { icon: null, text: 'Downloading 42%', tone: 'progress', click: 'panel' });
    assert.deepEqual(buttonView(state({ status: 'ready' })), { icon: null, text: 'Restart to update', tone: 'ready', click: 'restart' });
    assert.deepEqual(buttonView(state({ status: 'installing' })), { icon: null, text: 'Installing…', tone: 'progress', click: 'panel' });
    assert.deepEqual(buttonView(state({ status: 'error', error: 'boom' })), { icon: null, text: 'Update failed', tone: 'failed', click: 'panel' });
  });

  test('downloading before the first progress report reads 0%', () => {
    assert.equal(buttonView(state({ status: 'downloading', progress: null })).text, 'Downloading 0%');
  });

  test('builds that cannot update themselves get the same notice', () => {
    for (const kind of ['manual', 'portable', 'pacman']) assert.equal(buttonView(state({ kind })).text, 'Update 0.3.1', kind);
  });

  test('an unknown status shows nothing rather than a broken button', () => {
    assert.equal(buttonView(state({ status: 'checking' })), null);
    assert.equal(buttonView(state({ latest: null })), null);
  });
});

describe('panelView', () => {
  test('nothing to show while the button is hidden', () => {
    assert.equal(panelView(state({ status: 'none', latest: null })), null);
    assert.equal(panelView(null), null);
  });

  test('heading, running version and notes', () => {
    const v = panelView(state());
    assert.equal(v.title, 'MQTT Scope 0.3.1');
    assert.equal(v.current, 'You have 0.3.0');
    assert.equal(v.notes, 'Fixed things');
    assert.equal(v.noNotes, false);
  });

  test('notes stay the raw text: rendering them as text is the DOM side’s job', () => {
    const notes = '<img src=x onerror=alert(1)>\n- item';
    assert.equal(panelView(state({ latest: { version: '0.3.1', notes } })).notes, notes);
  });

  test('empty or blank notes say so', () => {
    for (const notes of ['', '  \n\t ', undefined, null]) {
      const v = panelView(state({ latest: { version: '0.3.1', notes } }));
      assert.equal(v.notes, 'No release notes.', JSON.stringify(notes));
      assert.equal(v.noNotes, true);
    }
  });

  describe('self-updating builds (AppImage, Windows installer)', () => {
    test('available: download or later; skip and the release page', () => {
      for (const kind of ['appimage', 'nsis']) {
        const v = panelView(state({ kind }));
        assert.deepEqual(v.actions, [
          { id: 'download', label: 'Download update', primary: true, disabled: false },
          { id: 'later', label: 'Later', primary: false, disabled: false },
        ]);
        assert.deepEqual(v.links, [
          { id: 'skip', label: 'Skip this version' },
          { id: 'openRelease', label: 'Open release page' },
        ]);
        assert.equal(v.message, null);
        assert.equal(v.command, null);
      }
    });

    test('downloading: progress in place of the action, no skip', () => {
      const v = panelView(state({ status: 'downloading', progress: 7 }));
      assert.deepEqual(v.actions, [
        { id: 'progress', label: 'Downloading… 7%', primary: true, disabled: true },
        { id: 'later', label: 'Later', primary: false, disabled: false },
      ]);
      assert.deepEqual(ids(v.links), ['openRelease']);
      assert.equal(panelView(state({ status: 'downloading', progress: null })).actions[0].label, 'Downloading… 0%');
    });

    test('ready: restart or later, no skip', () => {
      const v = panelView(state({ status: 'ready' }));
      assert.deepEqual(labels(v.actions), ['Restart to update', 'Later']);
      assert.deepEqual(ids(v.actions), ['restart', 'later']);
      assert.deepEqual(ids(v.links), ['openRelease']);
      assert.equal(v.message, null);
    });

    test('ready and connected: asks inline, singular and plural', () => {
      const one = panelView(state({ status: 'ready' }), { confirm: 1 });
      assert.deepEqual(one.message, { text: 'Restarting disconnects 1 broker.', tone: 'warn' });
      assert.deepEqual(one.actions, [
        { id: 'confirmRestart', label: 'Restart', primary: true, disabled: false },
        { id: 'cancel', label: 'Cancel', primary: false, disabled: false },
      ]);
      assert.deepEqual(ids(one.links), ['openRelease']);
      assert.equal(panelView(state({ status: 'ready' }), { confirm: 3 }).message.text, 'Restarting disconnects 3 brokers.');
    });

    test('the confirm only applies while an update is ready', () => {
      for (const status of ['available', 'downloading', 'error']) {
        const v = panelView(state({ status, error: status === 'error' ? 'boom' : null }), { confirm: 2 });
        assert.ok(!ids(v.actions).includes('confirmRestart'), status);
      }
    });

    test('installing: progress in place of the actions, nothing to skip or postpone', () => {
      const v = panelView(state({ status: 'installing' }), { confirm: 1 });
      assert.deepEqual(v.actions, [{ id: 'progress', label: 'Installing…', primary: true, disabled: true }]);
      assert.deepEqual(ids(v.links), ['openRelease']);
      assert.equal(v.message, null, 'the confirm is over');
    });

    test('error: the message, retry or later; skip and the release page', () => {
      const v = panelView(state({ status: 'error', error: 'net::ERR_CONNECTION_RESET' }));
      assert.deepEqual(v.message, { text: 'net::ERR_CONNECTION_RESET', tone: 'error' });
      assert.deepEqual(labels(v.actions), ['Retry', 'Later']);
      assert.deepEqual(ids(v.actions), ['retry', 'later']);
      assert.deepEqual(ids(v.links), ['skip', 'openRelease']);
    });
  });

  test('builds that cannot update themselves: Download opens the release page; no separate link', () => {
    for (const kind of ['manual', 'portable', 'something-new']) {
      const v = panelView(state({ kind }));
      assert.deepEqual(v.actions, [
        { id: 'openRelease', label: 'Download', primary: true, disabled: false },
        { id: 'later', label: 'Later', primary: false, disabled: false },
      ]);
      assert.deepEqual(v.links, [{ id: 'skip', label: 'Skip this version' }], kind);
      assert.equal(v.message, null);
      assert.equal(v.command, null);
    }
  });

  test('pacman installs: the command to copy', () => {
    const command = 'mkdir -p ~/.cache/x && makepkg -si';
    const v = panelView(state({ kind: 'pacman', pacmanCommand: command }));
    assert.deepEqual(v.message, { text: 'Installed by the package manager. Update with:', tone: 'info' });
    assert.equal(v.command, command);
    assert.deepEqual(v.actions, [
      { id: 'copyCommand', label: 'Copy command', primary: true, disabled: false },
      { id: 'later', label: 'Later', primary: false, disabled: false },
    ]);
    assert.deepEqual(ids(v.links), ['skip', 'openRelease']);
  });

  test('every id is unique within a view (focus is kept by id across updates)', () => {
    const views = [
      panelView(state()),
      panelView(state({ status: 'downloading', progress: 1 })),
      panelView(state({ status: 'ready' })),
      panelView(state({ status: 'ready' }), { confirm: 1 }),
      panelView(state({ status: 'installing' })),
      panelView(state({ status: 'error', error: 'x' })),
      panelView(state({ kind: 'manual' })),
      panelView(state({ kind: 'pacman', pacmanCommand: 'c' })),
    ];
    for (const v of views) {
      const all = ids([...v.actions, ...v.links]);
      assert.equal(new Set(all).size, all.length, all.join());
    }
  });
});

describe('installingView (the dialog every main window shows while a restart installs)', () => {
  test('title and what happens next, per build', () => {
    assert.deepEqual(installingView(state({ status: 'installing', kind: 'nsis' })), {
      title: 'Installing MQTT Scope 0.3.1',
      text: 'MQTT Scope closes now. The installer shows its progress, then MQTT Scope opens again.',
    });
    assert.deepEqual(installingView(state({ status: 'installing', kind: 'appimage' })), {
      title: 'Installing MQTT Scope 0.3.1',
      text: 'MQTT Scope restarts in a moment.',
    });
  });

  test('no dialog in any other state', () => {
    for (const status of ['none', 'available', 'downloading', 'ready', 'error', 'checking']) {
      assert.equal(installingView(state({ status, kind: 'nsis' })), null, status);
    }
    assert.equal(installingView(null), null);
    assert.equal(installingView(undefined), null);
    assert.equal(installingView(state({ status: 'installing', latest: null })), null);
  });

  test('only builds that install updates themselves', () => {
    for (const kind of ['manual', 'portable', 'pacman', 'dev']) assert.equal(installingView(state({ status: 'installing', kind })), null, kind);
  });
});

describe('checkedView (Settings → Check for updates)', () => {
  test('latest, error and disabled are toasts', () => {
    assert.deepEqual(checkedView({ result: 'latest' }, state({ status: 'none', latest: null })), { toast: "You're on the latest version (0.3.0)", kind: 'info' });
    assert.deepEqual(checkedView({ result: 'error', error: 'HTTP 503' }, state()), { toast: "Couldn't check for updates: HTTP 503", kind: 'error' });
    assert.deepEqual(checkedView({ result: 'disabled' }, state({ kind: 'dev', status: 'none', latest: null })), {
      toast: 'Update checks are off in development builds',
      kind: 'info',
    });
  });

  test('available opens the panel', () => {
    assert.deepEqual(checkedView({ result: 'available', version: '0.3.1' }, state()), { open: true });
  });

  test('nothing while an update installs: nothing may take focus from the Installing dialog', () => {
    for (const result of ['available', 'latest', 'error', 'disabled']) {
      assert.equal(checkedView({ result, version: '0.3.1', error: 'x' }, state({ status: 'installing' })), null, result);
    }
  });

  test('anything else is ignored', () => {
    for (const r of [null, undefined, {}, { result: 'what' }, 'latest']) assert.equal(checkedView(r, state()), null, JSON.stringify(r));
  });
});

test('the renderer knows the same self-updating kinds as main', () => {
  assert.deepEqual([...SELF_UPDATING_KINDS].sort(), [...SELF_UPDATING].sort());
});
