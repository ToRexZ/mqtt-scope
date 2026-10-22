// The AppImage's menu entry and icons: the pure part (which builds integrate,
// Exec quoting, the entry, where things go, what to write), then the file
// work against a temporary folder that stands in for the home folder, the
// system data folders and the running AppImage. Nothing here touches the real
// home folder: every call passes its own env and home.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireFromRoot, prng } from './_util.mjs';

const { MARKER, shouldIntegrate, execArg, desktopEntry, locations, providesApp, isOurs, plan, integrateDesktop } = requireFromRoot('./main/desktopIntegration.js');
const { description } = requireFromRoot('./package.json');

const APPIMAGE = '/home/u/Applications/MQTT-Scope-0.3.0-linux-x86_64.AppImage';
const ODD = `/home/u/My Apps/it's "MQTT" $HOME 100%/MQTT-Scope.AppImage`;

// Reads a desktop entry back the way the spec says a launcher does: the string
// escapes first, then the Exec quoting, then the field codes.
function unescapeValue(v) {
  return v.replace(/\\(.)/g, (_m, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? `\\${c}`);
}
function execArgv(exec) {
  const args = [];
  let i = 0;
  while (i < exec.length) {
    if (exec[i] === ' ') {
      i++;
      continue;
    }
    let arg = '';
    if (exec[i] === '"') {
      for (i++; exec[i] !== '"'; i++) {
        if (i >= exec.length) throw new Error(`unclosed quote in ${exec}`);
        if (exec[i] === '\\' && '"`$\\'.includes(exec[i + 1])) i++;
        arg += exec[i];
      }
      i++;
    } else {
      for (; i < exec.length && exec[i] !== ' '; i++) arg += exec[i];
    }
    args.push(arg === '%U' ? arg : arg.replaceAll('%%', '%'));
  }
  return args;
}
function readEntry(text) {
  const keys = {};
  for (const line of text.split('\n').slice(1)) {
    if (!line) continue;
    const at = line.indexOf('=');
    assert.ok(at > 0, `not a key=value line: ${JSON.stringify(line)}`);
    const key = line.slice(0, at);
    assert.ok(!(key in keys), `${key} appears twice`);
    keys[key] = unescapeValue(line.slice(at + 1));
  }
  return keys;
}

describe('shouldIntegrate', () => {
  const on = { kind: 'appimage', platform: 'linux', isPackaged: true, appImage: APPIMAGE };

  test('a packaged AppImage on Linux', () => {
    assert.equal(shouldIntegrate(on), true);
  });
  test('no other kind', () => {
    for (const kind of ['pacman', 'manual', 'dev', 'nsis', 'portable']) assert.equal(shouldIntegrate({ ...on, kind }), false, kind);
  });
  test('never unpackaged (npm start, the tests), whatever MQTTSCOPE_UPDATE_KIND says', () => {
    assert.equal(shouldIntegrate({ ...on, isPackaged: false }), false);
  });
  test('only on Linux', () => {
    for (const platform of ['win32', 'darwin']) assert.equal(shouldIntegrate({ ...on, platform }), false, platform);
  });
  test('only with the AppImage path to launch', () => {
    for (const appImage of ['', undefined]) assert.equal(shouldIntegrate({ ...on, appImage }), false, String(appImage));
  });
});

describe('execArg', () => {
  test('a plain path stays as it is', () => {
    assert.equal(execArg(APPIMAGE), APPIMAGE);
  });
  test('a path with spaces, quotes, $ and % is quoted, escaped and has %%', () => {
    assert.equal(execArg(ODD), String.raw`"/home/u/My Apps/it's \"MQTT\" \$HOME 100%%/MQTT-Scope.AppImage"`);
  });
  test('backslash and backtick are escaped inside the quotes', () => {
    assert.equal(execArg('/a\\b`c'), '"/a\\\\b\\`c"');
  });
  test('every reserved character makes it quoted', () => {
    for (const c of [' ', '\t', '\n', '"', "'", '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')', '`']) {
      const quoted = execArg(`/a${c}b`);
      assert.ok(quoted.startsWith('"/a') && quoted.endsWith('b"'), JSON.stringify(c));
    }
  });
  test('% alone needs no quotes, only doubling', () => {
    assert.equal(execArg('/opt/100%/x'), '/opt/100%%/x');
  });
});

describe('desktopEntry', () => {
  test('the whole entry', () => {
    assert.equal(
      desktopEntry({ appImage: APPIMAGE }),
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=MQTT Scope',
        `Comment=${description}`,
        `Exec=${APPIMAGE} %U`,
        `TryExec=${APPIMAGE}`,
        'Icon=mqtt-scope',
        'StartupWMClass=mqtt-scope',
        'Terminal=false',
        'Categories=Development;',
        'X-MQTT-Scope-Integration=AppImage',
        '',
      ].join('\n'),
    );
  });
  test('Exec is quoted, then string-escaped; TryExec only string-escaped', () => {
    const lines = desktopEntry({ appImage: ODD }).split('\n');
    assert.ok(lines.includes(String.raw`Exec="/home/u/My Apps/it's \\"MQTT\\" \\$HOME 100%%/MQTT-Scope.AppImage" %U`), lines.join('\n'));
    assert.ok(lines.includes(`TryExec=${ODD}`));
  });
  test('a newline in the path cannot add a key', () => {
    const keys = readEntry(desktopEntry({ appImage: '/tmp/x\nExec=/bin/evil\n/MQTT.AppImage' }));
    assert.deepEqual(execArgv(keys.Exec), ['/tmp/x\nExec=/bin/evil\n/MQTT.AppImage', '%U']);
    assert.equal(keys.TryExec, '/tmp/x\nExec=/bin/evil\n/MQTT.AppImage');
  });
  test('any path reads back as itself (random paths of reserved characters)', () => {
    const r = prng(5050);
    const alphabet = [...'aZ09-_./ \t"\'\\><~|&;$*?#()`%=é😀', '%U', '%%', '\\\\', '\\"', '$('];
    for (let n = 0; n < 500; n++) {
      let p = '/';
      for (let len = r.int(1, 24); len > 0; len--) p += r.pick(alphabet);
      const keys = readEntry(desktopEntry({ appImage: p }));
      assert.deepEqual(execArgv(keys.Exec), [p, '%U'], JSON.stringify(p));
      assert.equal(keys.TryExec, p, JSON.stringify(p));
    }
  });
  test('the comment is escaped too', () => {
    assert.ok(desktopEntry({ appImage: APPIMAGE, comment: 'a\\b\nc' }).includes('\nComment=a\\\\b\\nc\n'));
  });
});

describe('locations', () => {
  const at = (env, appDir = '/tmp/.mount_MQTTab') => locations({ env, home: '/home/u', appDir });

  test('defaults: ~/.local/share, then /usr/local/share and /usr/share', () => {
    assert.deepEqual(at({}), {
      dataHome: '/home/u/.local/share',
      entry: '/home/u/.local/share/applications/mqtt-scope.desktop',
      iconDir: '/home/u/.local/share/icons/hicolor',
      applicationDirs: ['/home/u/.local/share/applications', '/usr/local/share/applications', '/usr/share/applications'],
    });
  });
  test('XDG_DATA_HOME and XDG_DATA_DIRS when set', () => {
    const l = at({ XDG_DATA_HOME: '/data', XDG_DATA_DIRS: '/sys1:/sys2/' });
    assert.equal(l.entry, '/data/applications/mqtt-scope.desktop');
    assert.equal(l.iconDir, '/data/icons/hicolor');
    assert.deepEqual(l.applicationDirs, ['/data/applications', '/sys1/applications', '/sys2/applications']);
  });
  test('empty or relative values count as unset (XDG spec)', () => {
    for (const XDG_DATA_HOME of ['', 'rel/share']) assert.equal(at({ XDG_DATA_HOME }).dataHome, '/home/u/.local/share', XDG_DATA_HOME);
    assert.deepEqual(at({ XDG_DATA_DIRS: '' }).applicationDirs, at({}).applicationDirs);
    assert.deepEqual(at({ XDG_DATA_DIRS: 'rel::/sys' }).applicationDirs, ['/home/u/.local/share/applications', '/sys/applications']);
  });
  test('ignores data dirs inside the AppImage (AppRun adds $APPDIR/usr/share/), and duplicates', () => {
    const env = { XDG_DATA_DIRS: '/tmp/.mount_MQTTab/usr/share/:/tmp/.mount_MQTTab:/tmp/.mount_MQTTab-x/share:/usr/share:/usr/share/:/home/u/.local/share' };
    assert.deepEqual(at(env).applicationDirs, ['/home/u/.local/share/applications', '/tmp/.mount_MQTTab-x/share/applications', '/usr/share/applications']);
  });
});

describe('providesApp and isOurs', () => {
  test('a StartupWMClass=mqtt-scope line provides the app', () => {
    assert.equal(providesApp('[Desktop Entry]\nName=X\nStartupWMClass=mqtt-scope\n'), true);
    assert.equal(providesApp('[Desktop Entry]\nStartupWMClass = mqtt-scope \r\nName=X'), true);
    for (const text of ['StartupWMClass=mqtt-scope-dev', 'StartupWMClass=MQTT Scope', '# StartupWMClass=mqtt-scope', 'XStartupWMClass=mqtt-scope', ''])
      assert.equal(providesApp(text), false, text);
  });
  test('ours carries the marker line', () => {
    assert.equal(MARKER, 'X-MQTT-Scope-Integration=AppImage');
    assert.equal(isOurs(desktopEntry({ appImage: APPIMAGE })), true);
    assert.equal(isOurs('[Desktop Entry]\nStartupWMClass=mqtt-scope\n'), false);
    assert.equal(isOurs('# X-MQTT-Scope-Integration=AppImage'), false);
  });
});

describe('plan', () => {
  const entryFile = '/d/applications/mqtt-scope.desktop';
  const entry = desktopEntry({ appImage: APPIMAGE });
  const png = (s) => Buffer.from(s);
  const icons = (have = [null, null]) => [
    { file: '/d/icons/hicolor/16x16/apps/mqtt-scope.png', want: png('16'), have: have[0] },
    { file: '/d/icons/hicolor/512x512/apps/mqtt-scope.png', want: png('512'), have: have[1] },
  ];
  const noLauncher = () => null;
  const never = () => assert.fail('looked for other launchers');

  test('nothing there yet: the icons, then the entry', () => {
    assert.deepEqual(plan({ entryFile, entry, current: null, icons: icons(), launcher: noLauncher }), {
      write: [
        { file: '/d/icons/hicolor/16x16/apps/mqtt-scope.png', data: png('16') },
        { file: '/d/icons/hicolor/512x512/apps/mqtt-scope.png', data: png('512') },
        { file: entryFile, data: entry },
      ],
    });
  });
  test('all current: nothing to write, and no looking for other launchers', () => {
    assert.deepEqual(plan({ entryFile, entry, current: entry, icons: icons([png('16'), png('512')]), launcher: never }), { write: [] });
  });
  test('only what differs: a changed logo', () => {
    assert.deepEqual(plan({ entryFile, entry, current: entry, icons: icons([png('16'), png('old')]), launcher: noLauncher }), {
      write: [{ file: '/d/icons/hicolor/512x512/apps/mqtt-scope.png', data: png('512') }],
    });
  });
  test('only what differs: the AppImage was renamed by an update', () => {
    const before = desktopEntry({ appImage: '/home/u/Applications/MQTT-Scope-0.2.9-linux-x86_64.AppImage' });
    assert.deepEqual(plan({ entryFile, entry, current: before, icons: icons([png('16'), png('512')]), launcher: noLauncher }), {
      write: [{ file: entryFile, data: entry }],
    });
  });
  test('a mqtt-scope.desktop that is not ours: left alone, nothing else looked at', () => {
    const current = '[Desktop Entry]\nExec=mqtt-scope\n';
    assert.deepEqual(plan({ entryFile, entry, current, icons: icons(), launcher: never }), { skip: `${entryFile} is not ours` });
  });
  test('another launcher provides the app: nothing written', () => {
    const launcher = () => '/usr/share/applications/mqtt-scope.desktop';
    assert.deepEqual(plan({ entryFile, entry, current: null, icons: icons(), launcher }), { skip: '/usr/share/applications/mqtt-scope.desktop provides the app' });
  });
  test('another launcher appeared after ours: ours goes (it would hide theirs, which has the same name), icons stay', () => {
    const launcher = () => '/usr/share/applications/mqtt-scope.desktop';
    const before = desktopEntry({ appImage: '/old.AppImage' });
    for (const have of [[png('16'), png('512')], [null, png('old')]]) {
      assert.deepEqual(plan({ entryFile, entry, current: before, icons: icons(have), launcher }), {
        remove: entryFile,
        reason: '/usr/share/applications/mqtt-scope.desktop provides the app',
      });
    }
  });
});

describe('integrateDesktop (files)', () => {
  let root, appDir, home, dataHome, sysDir, logs;
  const log = {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
  };
  const entryPath = () => path.join(dataHome, 'applications', 'mqtt-scope.desktop');
  const themeDir = () => path.join(dataHome, 'icons', 'hicolor');
  const iconPath = (size) => path.join(themeDir(), size, 'apps', 'mqtt-scope.png');
  const writeFile = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const shipIcon = (size, data) => writeFile(path.join(appDir, 'usr', 'share', 'icons', 'hicolor', size, 'apps', 'mqtt-scope.png'), data);
  const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);
  const run = (over = {}) =>
    integrateDesktop({
      kind: 'appimage',
      platform: 'linux',
      isPackaged: true,
      env: { APPIMAGE: path.join(root, 'MQTT-Scope-0.3.0.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir },
      home,
      execPath: path.join(appDir, 'mqtt-scope'),
      log,
      ...over,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttscope-desktop-'));
    appDir = path.join(root, 'mount');
    home = path.join(root, 'home');
    dataHome = path.join(home, '.local', 'share');
    sysDir = path.join(root, 'usr-share');
    logs = [];
    shipIcon('16x16', 'png16');
    shipIcon('512x512', 'png512');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('first start: writes the entry and every icon the AppImage ships, says so once', () => {
    run();
    assert.equal(fs.readFileSync(entryPath(), 'utf8'), desktopEntry({ appImage: path.join(root, 'MQTT-Scope-0.3.0.AppImage') }));
    assert.equal(fs.readFileSync(iconPath('16x16'), 'utf8'), 'png16');
    assert.equal(fs.readFileSync(iconPath('512x512'), 'utf8'), 'png512');
    assert.deepEqual(files(path.join(dataHome, 'applications')), ['mqtt-scope.desktop']); // no temporary files left
    assert.deepEqual(files(path.join(dataHome, 'icons', 'hicolor')), ['16x16', '16x16/apps', '16x16/apps/mqtt-scope.png', '512x512', '512x512/apps', '512x512/apps/mqtt-scope.png']);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'info');
    assert.equal(logs[0][1], 'desktop');
    assert.match(logs[0][2], /mqtt-scope\.desktop/);
  });

  test('an unchanged start writes and logs nothing', () => {
    run();
    const mtimes = [entryPath(), iconPath('16x16')].map((f) => fs.statSync(f).mtimeMs);
    fs.utimesSync(entryPath(), new Date(1000), new Date(1000));
    fs.utimesSync(iconPath('16x16'), new Date(1000), new Date(1000));
    logs = [];
    run();
    assert.deepEqual(logs, []);
    assert.deepEqual([entryPath(), iconPath('16x16')].map((f) => fs.statSync(f).mtimeMs), [1000, 1000], `was ${mtimes}`);
  });

  test('after a self-update renamed the AppImage, Exec and TryExec follow it; icons stay', () => {
    run();
    fs.utimesSync(iconPath('16x16'), new Date(1000), new Date(1000));
    logs = [];
    const next = path.join(root, 'MQTT-Scope-0.3.1.AppImage');
    run({ env: { APPIMAGE: next, APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir } });
    const keys = readEntry(fs.readFileSync(entryPath(), 'utf8'));
    assert.deepEqual(execArgv(keys.Exec), [next, '%U']);
    assert.equal(keys.TryExec, next);
    assert.equal(fs.statSync(iconPath('16x16')).mtimeMs, 1000);
    assert.equal(logs.length, 1);
  });

  test('a new logo in a later version replaces the icons and marks the icon theme changed', () => {
    run();
    fs.utimesSync(themeDir(), new Date(1000), new Date(1000));
    shipIcon('512x512', 'new512');
    run();
    assert.equal(fs.readFileSync(iconPath('512x512'), 'utf8'), 'new512');
    // GTK reloads an icon theme only when the theme folder's mtime changes.
    assert.ok(fs.statSync(themeDir()).mtimeMs > 1000);
  });

  test('the icon theme is not touched when no icon changed', () => {
    run();
    fs.utimesSync(themeDir(), new Date(1000), new Date(1000));
    run({ env: { APPIMAGE: path.join(root, 'MQTT-Scope-0.3.1.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir } });
    run();
    assert.equal(fs.statSync(themeDir()).mtimeMs, 1000);
  });

  test('without APPDIR, the icons come from the folder of the executable', () => {
    run({ env: { APPIMAGE: path.join(root, 'A.AppImage'), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir } });
    assert.equal(fs.readFileSync(iconPath('512x512'), 'utf8'), 'png512');
  });

  test('the Arch package (or any launcher in a system data dir) provides the app: nothing written', () => {
    writeFile(path.join(sysDir, 'applications', 'mqtt-scope.desktop'), '[Desktop Entry]\nExec=mqtt-scope %U\nStartupWMClass=mqtt-scope\n');
    run();
    assert.deepEqual(files(dataHome), []);
    assert.deepEqual(logs, [['info', 'desktop', `no menu entry: ${path.join(sysDir, 'applications', 'mqtt-scope.desktop')} provides the app`]]);
  });

  test('the Arch package installed after our entry: ours is removed at the next change (logged once), icons stay', () => {
    run();
    writeFile(path.join(sysDir, 'applications', 'mqtt-scope.desktop'), '[Desktop Entry]\nExec=mqtt-scope %U\nStartupWMClass=mqtt-scope\n');
    logs = [];
    const update = { env: { APPIMAGE: path.join(root, 'MQTT-Scope-0.3.1.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir } };
    run(update);
    assert.equal(fs.existsSync(entryPath()), false);
    assert.equal(fs.readFileSync(iconPath('512x512'), 'utf8'), 'png512');
    const theirs = path.join(sysDir, 'applications', 'mqtt-scope.desktop');
    assert.deepEqual(logs, [['info', 'desktop', `removed the menu entry ${entryPath()}: ${theirs} provides the app`]]);
    logs = [];
    run(update);
    assert.equal(fs.existsSync(entryPath()), false);
    assert.deepEqual(logs, [['info', 'desktop', `no menu entry: ${theirs} provides the app`]]);
  });

  test('AppImageLauncher or Gear Lever already added it to the user menu: nothing written', () => {
    const theirs = path.join(dataHome, 'applications', 'appimagekit_0123-MQTT_Scope.desktop');
    writeFile(theirs, '[Desktop Entry]\nExec=/home/u/Applications/x.AppImage\nIcon=appimagekit_0123_mqtt-scope\nStartupWMClass=mqtt-scope\n');
    run();
    assert.deepEqual(files(path.join(dataHome, 'applications')), ['appimagekit_0123-MQTT_Scope.desktop']);
    assert.equal(fs.existsSync(path.join(dataHome, 'icons')), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0][2], /appimagekit_0123-MQTT_Scope\.desktop provides the app/);
  });

  test('a hand-made mqtt-scope.desktop (no marker) is left as it is', () => {
    writeFile(entryPath(), '[Desktop Entry]\nExec=/somewhere/else\n');
    run();
    assert.equal(fs.readFileSync(entryPath(), 'utf8'), '[Desktop Entry]\nExec=/somewhere/else\n');
    assert.equal(fs.existsSync(path.join(dataHome, 'icons')), false);
    assert.deepEqual(logs, [['info', 'desktop', `no menu entry: ${entryPath()} is not ours`]]);
  });

  test("launchers inside the AppImage's own data dir do not count", () => {
    writeFile(path.join(appDir, 'usr', 'share', 'applications', 'mqtt-scope.desktop'), 'StartupWMClass=mqtt-scope\n');
    run({ env: { APPIMAGE: path.join(root, 'A.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: `${appDir}/usr/share/:${sysDir}` } });
    assert.ok(fs.existsSync(entryPath()));
  });

  test('our own entry does not count as another launcher', () => {
    run();
    run({ env: { APPIMAGE: path.join(root, 'B.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: sysDir } });
    assert.equal(readEntry(fs.readFileSync(entryPath(), 'utf8')).TryExec, path.join(root, 'B.AppImage'));
  });

  test('unreadable or odd files in the application dirs are skipped', () => {
    fs.mkdirSync(path.join(sysDir, 'applications', 'folder.desktop'), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing'), path.join(sysDir, 'applications', 'dangling.desktop'));
    writeFile(path.join(sysDir, 'applications', 'notes.txt'), 'StartupWMClass=mqtt-scope\n');
    run();
    assert.ok(fs.existsSync(entryPath()));
  });

  test('a failure is logged as a warning and never thrown', () => {
    writeFile(path.join(dataHome, 'icons'), 'a file where the icons folder goes');
    assert.doesNotThrow(() => run());
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.equal(logs[0][1], 'desktop');
  });

  test('no home folder and no XDG_DATA_HOME: a warning, nothing written relative to the working folder', () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      assert.doesNotThrow(() => run({ home: '', env: { APPIMAGE: path.join(root, 'A.AppImage'), APPDIR: appDir, XDG_DATA_DIRS: sysDir } }));
    } finally {
      process.chdir(cwd);
    }
    assert.equal(fs.existsSync(path.join(root, '.local')), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
  });

  test('other builds and unpackaged runs touch nothing', () => {
    for (const over of [{ kind: 'pacman' }, { kind: 'manual' }, { isPackaged: false }, { platform: 'win32' }]) run(over);
    run({ env: { APPIMAGE: '', APPDIR: appDir, XDG_DATA_HOME: dataHome } });
    assert.equal(fs.existsSync(home), false);
    assert.deepEqual(logs, []);
  });
});
