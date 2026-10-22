'use strict';

// The AppImage's menu entry. GNOME shows a window's icon only from an
// installed desktop entry that matches the window (app id mqtt-scope), and an
// AppImage started by double-click installs none, so it would show a generic
// icon. On every start the AppImage writes its own entry to
// <data home>/applications and copies its icons to <data home>/icons/hicolor,
// and rewrites them when they change (a self-update renames the AppImage file).
// It leaves both alone when another launcher already provides the app (the
// Arch package, AppImageLauncher, Gear Lever, a hand-made entry), and removes
// its entry when such a launcher turns up after it.
// The first part is pure; integrateDesktop() does the file work and never throws.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { description } = require('../package.json');

const APP_ID = 'mqtt-scope'; // the window's app id (package.json desktopName), the icon name
const ENTRY_FILE = `${APP_ID}.desktop`;
const ICON_FILE = `${APP_ID}.png`;
const MARKER = 'X-MQTT-Scope-Integration=AppImage'; // tells our entry from anyone else's

// Characters that make an Exec argument need quotes (Desktop Entry spec).
const RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;

function shouldIntegrate({ kind, platform, isPackaged, appImage }) {
  return isPackaged && platform === 'linux' && kind === 'appimage' && !!appImage;
}

// One Exec argument: % doubled; quoted, with " ` $ \ escaped, when it has a
// reserved character.
function execArg(arg) {
  const s = arg.replaceAll('%', '%%');
  return RESERVED.test(s) ? `"${s.replace(/["`$\\]/g, '\\$&')}"` : s;
}

// The escapes every string value gets (on top of Exec's quoting), so no value
// can break its line.
const ESCAPES = { '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
const escapeValue = (s) => s.replace(/[\\\n\t\r]/g, (c) => ESCAPES[c]);

// TryExec makes the desktop hide the entry once the AppImage file is gone.
function desktopEntry({ appImage, comment = description }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=MQTT Scope',
    `Comment=${escapeValue(comment)}`,
    `Exec=${escapeValue(execArg(appImage))} %U`,
    `TryExec=${escapeValue(appImage)}`,
    `Icon=${APP_ID}`,
    `StartupWMClass=${APP_ID}`,
    'Terminal=false',
    'Categories=Development;',
    MARKER,
    '',
  ].join('\n');
}

const isInside = (dir, parent) => {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Where our entry and icons go, and the application dirs where another
// launcher's entry could be (XDG Base Directory spec: unset, empty or relative
// values fall back to the defaults). The AppImage's own data dir is skipped:
// AppRun puts $APPDIR/usr/share/ first in XDG_DATA_DIRS.
function locations({ env, home, appDir }) {
  const dataHome = path.isAbsolute(env.XDG_DATA_HOME || '') ? path.resolve(env.XDG_DATA_HOME) : path.join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter((d) => path.isAbsolute(d))
    .map((d) => path.resolve(d))
    .filter((d) => !isInside(d, appDir));
  return {
    dataHome,
    entry: path.join(dataHome, 'applications', ENTRY_FILE),
    iconDir: path.join(dataHome, 'icons', 'hicolor'),
    applicationDirs: [...new Set([dataHome, ...dataDirs])].map((d) => path.join(d, 'applications')),
  };
}

const providesApp = (text) => /^[ \t]*StartupWMClass[ \t]*=[ \t]*mqtt-scope[ \t\r]*$/m.test(text);
const isOurs = (text) => text.split(/\r?\n/).includes(MARKER);

// What to do, given what is there now: { write: [{ file, data }] }, icons
// first so the entry never shows without them; { skip: reason }; or
// { remove: entryFile, reason } when another launcher appeared after our entry
// (ours, a user entry, would hide a package's entry of the same name). Our
// icons stay: they are the same logo.
// icons: [{ file, want, have (null if missing) }]; current: the text at
// entryFile, or null. launcher() returns another launcher's entry or null; it
// is only asked when something would be written.
function plan({ entryFile, entry, current, icons, launcher }) {
  if (current !== null && !isOurs(current)) return { skip: `${entryFile} is not ours` };
  const write = icons.filter((i) => !i.have || !i.have.equals(i.want)).map((i) => ({ file: i.file, data: i.want }));
  if (current !== entry) write.push({ file: entryFile, data: entry });
  if (!write.length) return { write };
  const other = launcher();
  if (!other) return { write };
  const reason = `${other} provides the app`;
  return current === null ? { skip: reason } : { remove: entryFile, reason };
}

// --- file work ---

const readOrNull = (file, encoding) => {
  try {
    return fs.readFileSync(file, encoding);
  } catch {
    return null;
  }
};

// The icons the running AppImage ships, at every size it has.
function shippedIcons(appDir, iconDir) {
  const from = path.join(appDir, 'usr', 'share', 'icons', 'hicolor');
  let sizes = [];
  try {
    sizes = fs.readdirSync(from).filter((d) => /^\d+x\d+$/.test(d));
  } catch {}
  const icons = [];
  for (const size of sizes) {
    const want = readOrNull(path.join(from, size, 'apps', ICON_FILE));
    if (!want) continue;
    const file = path.join(iconDir, size, 'apps', ICON_FILE);
    icons.push({ file, want, have: readOrNull(file) });
  }
  return icons;
}

// The first desktop entry other than ours that provides the app.
function otherLauncher(applicationDirs) {
  for (const dir of applicationDirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.desktop'));
    } catch {}
    for (const name of names) {
      const text = readOrNull(path.join(dir, name), 'utf8');
      if (text && providesApp(text) && !isOurs(text)) return path.join(dir, name);
    }
  }
  return null;
}

// The desktop watches these folders: it must never see half a file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function integrateDesktop({ kind, isPackaged, log, platform = process.platform, env = process.env, home, execPath = process.execPath }) {
  const appImage = env.APPIMAGE;
  if (!shouldIntegrate({ kind, platform, isPackaged, appImage })) return;
  try {
    const appDir = path.resolve(env.APPDIR || path.dirname(execPath));
    const where = locations({ env, home: home ?? os.homedir(), appDir });
    if (!path.isAbsolute(where.dataHome)) throw new Error('no home folder');
    const result = plan({
      entryFile: where.entry,
      entry: desktopEntry({ appImage }),
      current: readOrNull(where.entry, 'utf8'),
      icons: shippedIcons(appDir, where.iconDir),
      launcher: () => otherLauncher(where.applicationDirs),
    });
    if (result.skip) return log.info('desktop', `no menu entry: ${result.skip}`);
    if (result.remove) {
      fs.rmSync(result.remove, { force: true });
      return log.info('desktop', `removed the menu entry ${result.remove}: ${result.reason}`);
    }
    for (const { file, data } of result.write) writeAtomic(file, data);
    // GTK reloads an icon theme only when the theme folder's mtime changes
    // (xdg-icon-resource touches it too).
    if (result.write.some((w) => w.file !== where.entry)) fs.utimesSync(where.iconDir, new Date(), new Date());
    if (result.write.length) log.info('desktop', `menu entry for ${appImage}: wrote ${result.write.map((w) => path.relative(where.dataHome, w.file)).join(', ')} in ${where.dataHome}`);
  } catch (err) {
    log.warn('desktop', `could not add the menu entry: ${err.message}`);
  }
}

module.exports = {
  MARKER,
  shouldIntegrate,
  execArg,
  desktopEntry,
  locations,
  providesApp,
  isOurs,
  plan,
  integrateDesktop,
};
