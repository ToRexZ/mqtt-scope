// Release gate for the AppImage self-update: updates a real packaged AppImage
// of this version to a fake next patch release, end to end, and checks it comes
// back as the new version under the new file name with its settings intact.
// Two passes, each in a fresh folder: Restart to update (connected to a broker,
// so through the inline confirm), and install on quit.
//
// The app's update traffic only goes to a feed on 127.0.0.1 (through
// MQTTSCOPE_UPDATE_URL), which logs every request with its headers; a request
// that carries an install ID (x-user-staging-id other than the nil UUID) fails
// the pass. The builds use electron-builder's caches (a machine's first build
// downloads Electron).
// No FUSE needed (APPIMAGE_EXTRACT_AND_RUN=1).
// Linux x64 in a desktop session: electron-updater starts the new version
// itself, without Playwright's headless switch (its windows stay hidden).
//
//   node scripts/update-dry-run.mjs [--keep]
//
// Prints PASS restart-to-update and PASS install-on-quit, or FAIL with the
// reason and exits non-zero. --keep leaves the scratch folder (under $TMPDIR).

import { _electron as electron } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { profile } from '../test/helpers/app.mjs';
import { startBroker, sleep, until } from '../test/helpers/broker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const TO = FROM.replace(/\d+$/, (patch) => String(Number(patch) + 1)); // the fake next release
const appImage = (version) => `MQTT-Scope-${version}-linux-x86_64.AppImage`;
const KEEP = process.argv.includes('--keep');

// Every wait has a limit: a hung step fails the gate rather than hanging it.
const BUILD_MS = 15 * 60_000;
const STEP_MS = 60_000; // launching, connecting, the notice, a click
const DOWNLOAD_MS = 3 * 60_000;
const RELAUNCH_MS = 60_000; // from Restart to `start <TO>` in main.log
const QUIT_MS = 2 * 60_000; // quitting, which may unpack the new AppImage to install it
const TOTAL_MS = 45 * 60_000;

// Settings that differ from the defaults; the update must keep them.
const SETTINGS = { historyLimit: 250, autoExpand: false, checkForUpdates: true };
const CONFIRM = 'Restarting disconnects 1 broker.';
const NIL_UUID = '00000000-0000-0000-0000-000000000000'; // the x-user-staging-id the app sends
const startLine = new RegExp(` INFO start ${TO.replaceAll('.', '\\.')} `);

// Short names: Chromium's singleton socket goes in $TMPDIR/scoped_dir<6>/, and
// a Unix socket path must fit in 107 characters (checked before the builds).
const scratch = mkdtempSync(path.join(tmpdir(), 'mqttscope-'));
const PASSES = [
  { name: 'restart-to-update', folder: 'restart', finish: (ctx) => restartToUpdate(ctx) },
  { name: 'install-on-quit', folder: 'quit', finish: (ctx) => installOnQuit(ctx) },
];
const MAX_SOCKET_PATH = 107;
const longestTmp = Math.max(...PASSES.map((p) => path.join(scratch, p.folder, 'tmp/scoped_dirXXXXXX/SingletonSocket').length));
const feedDir = path.join(scratch, 'feed');
const groups = new Set(); // process groups of running commands (see run)
let feedSha512 = null;
let stepClock = Date.now();

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const step = (text) => console.log(`  [${secs(Date.now() - stepClock)}] ${text}`);
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const tail = (file, n) => readText(file).trimEnd().split('\n').slice(-n).join('\n');
const indent = (text) => text.replace(/^/gm, '    ');

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${secs(ms)}: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Polls `fn` until it returns true or `ms` pass; returns whether it did.
async function settle(fn, ms) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await sleep(100);
  }
  return true;
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

// Runs a command with its output in `log`, as its own process group so that a
// timeout (or an abort) ends everything it started.
function run(cmd, args, { log, cwd = root, env = process.env, timeout = BUILD_MS }) {
  return new Promise((resolve, reject) => {
    const out = openSync(log, 'w');
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', out, out], detached: true });
    closeSync(out);
    if (child.pid) groups.add(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${cmd}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      groups.delete(child.pid);
      if (code === 0) return resolve();
      const why = timedOut ? `timed out after ${secs(timeout)}` : signal ? `was killed (${signal})` : `exited with ${code}`;
      reject(new Error(`${cmd} ${args.join(' ')} ${why}. End of its output:\n${indent(tail(log, 30))}`));
    });
  });
}

// 'bytes=0-99, 200-' -> [[0, 99], [200, size - 1]]; null for no header or one
// this server does not understand (it then sends the whole file, as HTTP allows).
function parseRanges(header, size) {
  const m = /^bytes=(.+)$/.exec(header || '');
  if (!m) return null;
  const ranges = m[1].split(',').map((part) => {
    const r = /^\s*(\d+)-(\d*)\s*$/.exec(part);
    if (!r) return null;
    const start = Number(r[1]);
    const end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    return start <= end ? [start, end] : null;
  });
  return ranges.every(Boolean) ? ranges : null;
}

// The update feed: serves the files in `dir` by name on 127.0.0.1, with byte
// ranges (electron-updater downloads only the changed blocks of an AppImage,
// many ranges per request), and records every request with its headers.
async function startFeed(dir) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, status: 404, bytes: 0 };
    requests.push(entry);
    const closed = new Promise((resolve) => res.once('close', resolve));
    const send = async (file, start, end) => {
      for await (const chunk of createReadStream(file, { start, end })) {
        entry.bytes += chunk.length;
        if (!res.write(chunk)) await Promise.race([new Promise((resolve) => res.once('drain', resolve)), closed]);
        if (res.destroyed) return;
      }
    };
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://feed').pathname.slice(1));
      const file = path.join(dir, name);
      if (req.method !== 'GET' || !/^[\w.-]+$/.test(name) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
      const { size } = statSync(file);
      const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      const ranges = parseRanges(req.headers.range, size);
      if (!ranges) {
        res.writeHead((entry.status = 200), { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
        await send(file, 0, size - 1);
      } else if (ranges.length === 1) {
        const [[start, end]] = ranges;
        res.writeHead((entry.status = 206), { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
        await send(file, start, end);
      } else {
        const boundary = randomBytes(12).toString('hex');
        res.writeHead((entry.status = 206), { 'content-type': `multipart/byteranges; boundary=${boundary}` });
        for (const [i, [start, end]] of ranges.entries()) {
          res.write(`${i ? '\r\n' : ''}--${boundary}\r\ncontent-type: ${type}\r\ncontent-range: bytes ${start}-${end}/${size}\r\n\r\n`);
          await send(file, start, end);
        }
        res.write(`\r\n--${boundary}--\r\n`);
      }
      res.end();
    } catch (err) {
      entry.error = err.message;
      res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// What the feed saw, for the review of what the app sends: every request with
// all its headers, then where x-user-staging-id (electron-updater's) went and
// whether anything sent the install ID electron-updater keeps in
// data/.updaterId. Returns false if a request identified the install.
function printFeed(requests, updaterIdFile) {
  const pathOf = (r) => r.url.split('?')[0];
  const paths = (rs) => (rs.length ? ` (${[...new Set(rs.map(pathOf))].join(', ')})` : '');
  console.log(`  feed requests (${requests.length}):`);
  for (const r of requests) {
    const { range, ...headers } = r.headers;
    const ranges = range ? `, ${range.split(',').length} range(s)` : '';
    console.log(`    ${r.method} ${r.url} -> ${r.status}${ranges}, ${r.bytes} bytes${r.error ? `, error: ${r.error}` : ''}`);
    for (const [k, v] of Object.entries(headers)) console.log(`      ${k}: ${v}`);
  }
  const staged = requests.filter((r) => 'x-user-staging-id' in r.headers);
  const nil = staged.filter((r) => r.headers['x-user-staging-id'] === NIL_UUID);
  const other = staged.filter((r) => r.headers['x-user-staging-id'] !== NIL_UUID);
  const otherIds = [...new Set(other.map((r) => r.headers['x-user-staging-id']))];
  console.log(
    `  x-user-staging-id: the nil UUID on ${nil.length} of ${requests.length} requests${paths(nil)}; absent on ${requests.length - staged.length}; ` +
      (other.length ? `ANOTHER VALUE (an install ID) on ${other.length}${paths(other)}: ${otherIds.join(', ')}` : 'any other value: on none'),
  );
  const saved = readText(updaterIdFile).trim() || null;
  const sentSaved = !!saved && requests.some((r) => Object.values(r.headers).some((v) => String(v).includes(saved)));
  console.log(`  data/.updaterId: ${saved ? `${saved}, ${sentSaved ? 'SENT with a request' : 'kept locally, sent with no request'}` : 'absent'}`);
  return other.length === 0 && !sentSaved;
}

// The processes of this run under `dir`: everything whose executable or
// command line starts there (the unpacked 0.3.0 binary, the installed
// AppImage's runtime, the copy of the app it unpacks under <dir>/tmp, and
// their helper processes). `cmd` is the command line as one string: Chromium
// rewrites its processes' titles that way.
function processesUnder(dir) {
  const prefix = dir + path.sep;
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmd;
    let exe = '';
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0+$/, '').replaceAll('\0', ' ');
    } catch {
      continue; // gone meanwhile
    }
    try {
      exe = readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, '');
    } catch {} // unreadable for sandboxed helpers; their command line still tells
    if (exe.startsWith(prefix) || cmd.startsWith(prefix)) found.push({ pid: Number(entry), exe, cmd });
  }
  return found;
}

const program = (p) => p.exe || p.cmd.split(' ')[0];
const isAppMain = (p) => path.basename(program(p)) === 'mqtt-scope' && !/ --type=/.test(p.cmd);
function describeProcesses(procs) {
  const describe = (p) => {
    const type = / --type=(\S+)/.exec(p.cmd)?.[1];
    return `${p.pid} ${path.relative(scratch, program(p))}${type ? ` (${type})` : ''}`;
  };
  return procs.map(describe).join('; ') || 'none';
}

// Ends this run's processes under `dir`: SIGTERM to the app's main processes
// (Electron quits cleanly and the AppImage runtime then deletes its unpacked
// copy), SIGKILL for whatever is left after 15 s. Says how it went.
async function endProcesses(dir) {
  const signal = (procs, sig) => {
    for (const p of procs) {
      try {
        process.kill(p.pid, sig);
      } catch {}
    }
  };
  const gone = () => processesUnder(dir).length === 0;
  if (gone()) return 'none running';
  const t = Date.now();
  signal(processesUnder(dir).filter(isAppMain), 'SIGTERM');
  if (await settle(gone, 15_000)) return `quit on SIGTERM in ${secs(Date.now() - t)}`;
  const left = processesUnder(dir);
  signal(left, 'SIGKILL');
  if (await settle(gone, 5_000)) return `needed SIGKILL for ${describeProcesses(left)}`;
  throw new Error(`Processes survived SIGKILL: ${describeProcesses(processesUnder(dir))}`);
}

// Last resort (Ctrl+C, the overall time limit, an unexpected error): kill
// everything this run started and leave.
function abort(reason, code) {
  console.log(`FAIL: ${reason}`);
  for (const pid of groups) killGroup(pid);
  for (const p of processesUnder(scratch)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {}
  }
  try {
    if (!KEEP) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
  process.exit(code);
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

// Steps 1 and 2 of the gate: this version's AppImage in dist/, and the feed:
// the same app built as TO, its latest-linux.yml and a release.json for it.
// Their temporary files go in the scratch folder too (electron-builder leaves some).
async function build() {
  const env = { ...process.env, TMPDIR: path.join(scratch, 'build-tmp') };
  mkdirSync(env.TMPDIR);
  rmSync(path.join(root, 'dist', appImage(FROM)), { force: true }); // an older build must not stand in for this one
  await run('npm', ['run', 'dist:linux', '--', '--publish', 'never'], { log: path.join(scratch, `build-${FROM}.log`), env });
  if (!existsSync(path.join(root, 'dist', appImage(FROM)))) throw new Error(`The build made no dist/${appImage(FROM)}`);
  step(`built dist/${appImage(FROM)}`);
  const args = ['electron-builder', '--linux', 'AppImage', '--publish', 'never', `-c.extraMetadata.version=${TO}`, `-c.directories.output=${feedDir}`];
  await run('npx', args, { log: path.join(scratch, `build-${TO}.log`), env });
  const yml = readText(path.join(feedDir, 'latest-linux.yml'));
  feedSha512 = /^sha512: (\S+)$/m.exec(yml)?.[1];
  if (/^version: (\S+)$/m.exec(yml)?.[1] !== TO) throw new Error(`The ${TO} build made no latest-linux.yml for ${TO}:\n${indent(yml || '(none)')}`);
  if (!feedSha512 || !existsSync(path.join(feedDir, appImage(TO)))) throw new Error(`The ${TO} build is incomplete: ${readdirSync(feedDir).join(', ')}`);
  writeFileSync(path.join(feedDir, 'release.json'), JSON.stringify({ tag_name: `v${TO}`, body: 'Dry run' }));
  step(`built the feed: ${appImage(TO)}, latest-linux.yml, release.json`);
}

const panelButton = (page, name) => page.locator('#update-panel').getByRole('button', { name, exact: true });

async function waitForUpdateButton(page, text, timeout) {
  try {
    await page.waitForFunction(
      (t) => {
        const b = document.querySelector('#btn-update');
        return !!b && !b.hidden && b.textContent === t;
      },
      text,
      { timeout, polling: 250 },
    );
  } catch (err) {
    const shown = await page.evaluate(() => document.querySelector('#btn-update')?.textContent).catch(() => '?');
    const state = await page.evaluate(() => window.api.updateState()).catch(() => null);
    throw new Error(`The update button never showed "${text}" (it shows "${shown}"; update state ${JSON.stringify(state)}): ${err.message.split('\n')[0]}`, { cause: err });
  }
}

// Steps 3 and 4 up to the downloaded update: connects to the broker, then
// ↑ Update <TO> → Download update → Restart to update.
async function upToRestart(ctx) {
  const page = await ctx.app.firstWindow({ timeout: STEP_MS });
  await page.waitForFunction(() => !!window.__mqttscope, null, { timeout: STEP_MS });
  await page.click('.conn-dialog .connect-btn', { timeout: STEP_MS });
  await page.waitForFunction(() => window.__mqttscope.status.state === 'connected', null, { timeout: STEP_MS, polling: 250 });
  step(`${FROM} is up and connected to the broker`);
  await waitForUpdateButton(page, `↑ Update ${TO}`, STEP_MS);
  step(`the top bar shows "↑ Update ${TO}"; opening the panel and clicking Download update`);
  await page.click('#btn-update', { timeout: STEP_MS });
  await panelButton(page, 'Download update').click({ timeout: STEP_MS });
  await waitForUpdateButton(page, 'Restart to update', DOWNLOAD_MS);
  step('downloaded: the top bar shows "Restart to update"');
  return page;
}

// The update replaced app/<FROM file> with app/<TO file>, byte for byte the feed's.
async function expectInstalled(ctx) {
  const files = readdirSync(ctx.appDir);
  step(`app/ now: ${files.join(', ') || '(empty)'}`);
  if (files.length !== 1 || files[0] !== appImage(TO)) throw new Error(`app/ holds ${files.join(', ') || 'nothing'}; expected just ${appImage(TO)}`);
  if (!(statSync(ctx.newFile).mode & 0o111)) throw new Error(`${appImage(TO)} is not executable`);
  if ((await sha512(ctx.newFile)) !== feedSha512) throw new Error(`${appImage(TO)} is not the feed's (sha512 differs from latest-linux.yml)`);
  step(`${appImage(TO)} is executable and matches latest-linux.yml's sha512`);
}

// Restart to update while connected: the inline confirm, then Restart; the app
// must come back as TO from the new file, with its settings, within 60 s.
async function restartToUpdate(ctx) {
  const page = await upToRestart(ctx);
  await page.click('#btn-update', { timeout: STEP_MS });
  await page.waitForFunction((t) => document.querySelector('#update-panel .update-message')?.textContent === t, CONFIRM, { timeout: STEP_MS, polling: 250 });
  step(`clicked Restart to update; the panel asks "${CONFIRM}"`);
  const settingsBefore = JSON.parse(readText(ctx.settingsFile) || 'null');
  if (!Object.entries(SETTINGS).every(([k, v]) => settingsBefore?.[k] === v)) throw new Error(`settings.json lost the seeded values before the update: ${JSON.stringify(settingsBefore)}`);
  const clicked = Date.now();
  // The app quits as soon as main hears this, so the page may go mid-click.
  await panelButton(page, 'Restart')
    .click({ timeout: STEP_MS })
    .catch((err) => {
      if (!/closed/i.test(err.message)) throw err;
    });
  step('clicked Restart');
  await until(() => startLine.test(readText(ctx.log)), {
    timeout: Math.max(0, clicked + RELAUNCH_MS - Date.now()), // RELAUNCH_MS from the click
    interval: 100,
    message: `\`start ${TO}\` in main.log within ${secs(RELAUNCH_MS)} of Restart`,
  });
  const relaunchedAt = Date.now();
  const old = await withTimeout(ctx.exited, QUIT_MS, `${FROM} to quit after Restart`);
  step(`${FROM} exited ${secs(old.at - clicked)} after Restart (code ${old.code}, signal ${old.signal}); main.log showed \`start ${TO}\` ${secs(relaunchedAt - clicked)} after Restart`);

  const procs = processesUnder(ctx.dir);
  const main = procs.find((p) => isAppMain(p) && program(p).startsWith(ctx.tmpDir + path.sep));
  if (!main) throw new Error(`main.log shows \`start ${TO}\`, but no ${TO} process runs: ${describeProcesses(procs)}`);
  const runtime = procs.find((p) => program(p) === ctx.newFile);
  const rel = (p) => path.relative(ctx.dir, p);
  // (Its APPIMAGE cannot be checked from outside: Chromium's process-title
  // rewriting blanks the main process's /proc/<pid>/environ.)
  if (!runtime) throw new Error(`The ${TO} main process ${main.pid} runs, but not under ${rel(ctx.newFile)}'s AppImage runtime: ${describeProcesses(procs)}`);
  step(`relaunched by electron-updater: ${TO} main process ${main.pid} (${rel(program(main))}), under AppImage runtime ${runtime.pid} (${rel(program(runtime))})`);
  await expectInstalled(ctx);

  // TO's startup update check proves it got through start(), and it reads settings.json.
  await until(() => ctx.feed.requests.some((r) => r.url === '/release.json' && r.headers['user-agent'] === `MQTT-Scope/${TO}`), {
    timeout: STEP_MS,
    message: `${TO}'s startup update check at the feed`,
  });
  step(`${TO} is running: its startup update check reached the feed`);
  const settingsAfter = JSON.parse(readText(ctx.settingsFile) || 'null');
  if (!isDeepStrictEqual(settingsAfter, settingsBefore)) throw new Error(`settings.json changed across the update: ${JSON.stringify(settingsBefore)} -> ${JSON.stringify(settingsAfter)}`);
  step(`settings intact: ${JSON.stringify(settingsAfter)}`);
  step(`ended ${TO}: ${await endProcesses(ctx.dir)}`);
}

// Quitting with a downloaded update installs it (electron-updater's
// autoInstallOnAppQuit) without starting the new version.
async function installOnQuit(ctx) {
  await upToRestart(ctx);
  const t = Date.now();
  await withTimeout(ctx.app.close(), QUIT_MS, `${FROM} to quit and install ${TO}`);
  step(`${FROM} quit in ${secs(Date.now() - t)}`);
  await expectInstalled(ctx);
  const log = readText(ctx.log);
  const installLine = log.split('\n').find((l) => l.includes('Auto install update on quit'));
  if (installLine) step(`main.log: ${installLine}`);
  if (startLine.test(log)) throw new Error(`Installing on quit also started ${TO}`);
  if (!(await settle(() => processesUnder(ctx.dir).length === 0, 10_000))) throw new Error(`Still running after the quit: ${describeProcesses(processesUnder(ctx.dir))}`);
  step('nothing left running');
}

// One pass in a fresh folder (<scratch>/<folder>): app/ (the AppImage the update replaces), data/
// (user data), tmp/ (where the AppImages unpack themselves), cache/
// (electron-updater's download), extract/ (the unpacked FROM binary Playwright
// starts). `finish(ctx)` drives it from the launched app onwards.
async function runPass({ folder, finish }) {
  const dir = path.join(scratch, folder);
  const sub = (d) => path.join(dir, d);
  for (const d of ['app', 'data', 'tmp', 'cache', 'extract']) mkdirSync(sub(d), { recursive: true });
  const ctx = {
    dir,
    appDir: sub('app'),
    tmpDir: sub('tmp'),
    oldFile: path.join(sub('app'), appImage(FROM)),
    newFile: path.join(sub('app'), appImage(TO)),
    settingsFile: path.join(sub('data'), 'settings.json'),
    log: path.join(sub('data'), 'logs', 'main.log'),
  };
  copyFileSync(path.join(root, 'dist', appImage(FROM)), ctx.oldFile);
  step(`app/ before: ${readdirSync(ctx.appDir).join(', ')}`);
  await run(ctx.oldFile, ['--appimage-extract'], { cwd: sub('extract'), log: path.join(dir, 'extract.log'), timeout: 2 * 60_000 });

  let broker;
  let failure = null;
  try {
    broker = await startBroker();
    ctx.feed = await startFeed(feedDir);
    writeFileSync(ctx.settingsFile, JSON.stringify(SETTINGS));
    writeFileSync(path.join(sub('data'), 'profiles.json'), JSON.stringify([profile(broker.port)]));
    // Passed on to the new version too (electron-updater starts it with this
    // process's environment), so it also stays inside the pass folder.
    const inherited = Object.entries(process.env).filter(([k]) => !/^(MQTTSCOPE_|APPIMAGE|APPDIR$|ARGV0$|OWD$)/.test(k));
    const env = {
      ...Object.fromEntries(inherited),
      APPIMAGE: ctx.oldFile,
      APPIMAGE_EXTRACT_AND_RUN: '1',
      MQTTSCOPE_UPDATE_URL: ctx.feed.url,
      MQTTSCOPE_USER_DATA: sub('data'),
      MQTTSCOPE_HIDDEN: '1',
      TMPDIR: ctx.tmpDir,
      XDG_CACHE_HOME: sub('cache'),
    };
    ctx.app = await electron.launch({ executablePath: path.join(sub('extract'), 'squashfs-root', 'mqtt-scope'), args: ['--ozone-platform=headless'], env, timeout: STEP_MS });
    const proc = ctx.app.process();
    ctx.exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
    await finish(ctx);
  } catch (err) {
    failure = err;
    console.log(`  main.log (end):\n${indent(tail(ctx.log, 25) || '(none)')}`);
    console.log(`  app/ now: ${readdirSync(ctx.appDir).join(', ') || '(empty)'}`);
  }
  if (ctx.feed && !printFeed(ctx.feed.requests, path.join(sub('data'), '.updaterId'))) {
    failure ||= new Error('An update request identified the install (see x-user-staging-id and data/.updaterId above)');
  }
  try {
    const ended = await endProcesses(dir);
    if (ended !== 'none running') step(`left running, now ended: ${ended}`);
  } catch (err) {
    failure ||= err;
  }
  await ctx.feed?.close();
  await broker?.close().catch(() => {});
  if (failure) throw failure;
}

process.on('SIGINT', () => abort('interrupted', 130));
process.on('SIGTERM', () => abort('terminated', 143));
process.on('SIGHUP', () => abort('hung up (the terminal went away)', 129));
process.on('uncaughtException', (err) => abort(`unexpected error: ${err.stack || err}`, 1));
process.on('unhandledRejection', (err) => abort(`unexpected error: ${err?.stack || err}`, 1));
setTimeout(() => abort(`the dry run took over ${TOTAL_MS / 60_000} min`, 1), TOTAL_MS).unref();

// Which code this run tested: the commit, and whether the tree had changes on top.
function sourceState() {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const changed = git('status', '--porcelain').split('\n').filter(Boolean).length;
    return `commit ${git('rev-parse', 'HEAD')}, ${changed ? `tree DIRTY (${changed} changed files)` : 'tree clean'}`;
  } catch (err) {
    return `commit unknown (${err.message.split('\n')[0]})`;
  }
}

console.log(`MQTT Scope AppImage update dry run, ${FROM} -> ${TO} (scratch: ${scratch})`);
console.log(sourceState());
let failed = false;
try {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error(`Linux x64 only (this is ${process.platform} ${process.arch})`);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('Needs a desktop session (DISPLAY or WAYLAND_DISPLAY) for the version electron-updater starts');
  if (longestTmp > MAX_SOCKET_PATH) throw new Error(`TMPDIR is too long (${tmpdir()}): the app's sockets under it would exceed ${MAX_SOCKET_PATH} characters. Run with a shorter one, e.g. TMPDIR=/tmp`);
  console.log('\n== builds');
  stepClock = Date.now();
  await build();
  for (const pass of PASSES) {
    console.log(`\n== ${pass.name}`);
    stepClock = Date.now();
    try {
      await runPass(pass);
      console.log(`PASS ${pass.name}`);
    } catch (err) {
      failed = true;
      console.log(`FAIL ${pass.name}: ${err.message}`);
    }
  }
} catch (err) {
  failed = true;
  console.log(`FAIL: ${err.message}`);
}
try {
  const ended = await endProcesses(scratch);
  if (ended !== 'none running') console.log(`Leftover processes ended: ${ended}`);
} catch (err) {
  failed = true;
  console.log(`FAIL: ${err.message}`);
}
if (KEEP) console.log(`Scratch folder kept: ${scratch}`);
else rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
process.exit(failed ? 1 : 0);
