'use strict';

// Pure helpers for the update notice: version compare, release parsing, install kind.
// No Electron or I/O here; callers inject `exists` and `env`.

const path = require('node:path');

const REPO = 'ToRexZ/mqtt-scope';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Kinds electron-updater can replace in place.
const SELF_UPDATING = new Set(['appimage', 'nsis']);

// Kinds MQTTSCOPE_UPDATE_KIND may force ('dev' is never forced).
const OVERRIDABLE_KINDS = new Set(['appimage', 'nsis', 'portable', 'pacman', 'manual']);

// 'v?MAJOR.MINOR.PATCH' -> [major, minor, patch]; anything else (pre-release, extra parts, spaces) -> null.
function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// GitHub "latest release" JSON -> { version, notes }, or null for drafts, pre-releases and odd tags.
function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft === true || json.prerelease === true) return null;
  const parts = parseVersion(json.tag_name);
  if (!parts) return null;
  return { version: parts.join('.'), notes: typeof json.body === 'string' ? json.body : '' };
}

function releasePageUrl(version) {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}

// Shell one-liner that fetches this release's PKGBUILD + desktop file and
// installs it, then removes the build folders (makepkg -c; they hold the whole
// app twice).
function pacmanCommand(version) {
  const dir = `~/.cache/mqtt-scope-pkg/${version}`;
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  return `mkdir -p ${dir} && cd ${dir} && curl -fLO ${base}/PKGBUILD -fLO ${base}/mqtt-scope.desktop && makepkg -sic`;
}

// How this build was installed, which decides how (or whether) it can update.
function installKind({ platform, env, isPackaged, resourcesPath, exists }) {
  const override = env.MQTTSCOPE_UPDATE_KIND;
  if (OVERRIDABLE_KINDS.has(override)) return override;
  if (!isPackaged) return env.MQTTSCOPE_UPDATE_URL ? 'manual' : 'dev';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage';
    if (exists(path.join(resourcesPath, 'pacman-package'))) return 'pacman';
  }
  return 'manual';
}

module.exports = {
  LATEST_RELEASE_API,
  CHECK_INTERVAL_MS,
  SELF_UPDATING,
  parseVersion,
  isNewer,
  parseRelease,
  releasePageUrl,
  pacmanCommand,
  installKind,
};
