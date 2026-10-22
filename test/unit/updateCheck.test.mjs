import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { requireFromRoot } from './_util.mjs';

const {
  LATEST_RELEASE_API,
  CHECK_INTERVAL_MS,
  SELF_UPDATING,
  parseVersion,
  isNewer,
  parseRelease,
  releasePageUrl,
  pacmanCommand,
  installKind,
} = requireFromRoot('./main/updateCheck.js');

describe('constants', () => {
  test('values', () => {
    assert.equal(LATEST_RELEASE_API, 'https://api.github.com/repos/ToRexZ/mqtt-scope/releases/latest');
    assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
    assert.deepEqual([...SELF_UPDATING].sort(), ['appimage', 'nsis']);
  });
});

describe('parseVersion', () => {
  test('accepts plain and v-prefixed', () => {
    assert.deepEqual(parseVersion('v0.3.1'), [0, 3, 1]);
    assert.deepEqual(parseVersion('0.3.1'), [0, 3, 1]);
    assert.deepEqual(parseVersion('10.20.30'), [10, 20, 30]);
  });
  test('rejects anything else', () => {
    const bad = [
      'v0.4.0-beta.1', 'release-1', '1.2', '1.2.3.4', '', 'v', 'vv1.2.3', 'V1.2.3',
      ' 1.2.3', '1.2.3 ', '1.2.3\n', '1.2.-3', '-1.2.3', '1..3', '1.2.x', '1.2.3+build',
      null, undefined, 123, 1.2, {}, [], ['1.2.3'], true,
    ];
    for (const b of bad) assert.equal(parseVersion(b), null, JSON.stringify(b));
  });
  test('leading zeros parse as numbers', () => {
    assert.deepEqual(parseVersion('01.002.0003'), [1, 2, 3]);
  });
  test('parts too large to be exact integers are rejected', () => {
    assert.equal(parseVersion('1.2.99999999999999999999'), null);
    assert.deepEqual(parseVersion('1.2.9007199254740991'), [1, 2, 9007199254740991]);
  });
});

describe('isNewer', () => {
  test('compares numerically per part', () => {
    assert.equal(isNewer('0.10.0', '0.9.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.3.1', '0.3.0'), true);
    assert.equal(isNewer('0.3.0', '0.3.0'), false);
    assert.equal(isNewer('0.2.9', '0.3.0'), false);
    assert.equal(isNewer('0.3.0', '0.3.1'), false);
  });
  test('v prefix and leading zeros are ignored', () => {
    assert.equal(isNewer('v0.3.1', '0.3.0'), true);
    assert.equal(isNewer('0.3.0', 'v0.3.0'), false);
    assert.equal(isNewer('0.03.0', '0.3.0'), false);
  });
  test('false when either side is unparsable', () => {
    assert.equal(isNewer('garbage', '0.3.0'), false);
    assert.equal(isNewer('0.3.1', 'garbage'), false);
    assert.equal(isNewer('0.4.0-beta.1', '0.3.0'), false);
    assert.equal(isNewer(undefined, '0.3.0'), false);
    assert.equal(isNewer('0.3.1', null), false);
    assert.equal(isNewer(), false);
  });
});

describe('parseRelease', () => {
  test('extracts version and notes', () => {
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: 'Fixed x' }), { version: '0.3.1', notes: 'Fixed x' });
    assert.deepEqual(parseRelease({ tag_name: '0.3.1', body: '' }), { version: '0.3.1', notes: '' });
  });
  test('missing or null body becomes empty notes', () => {
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: null }), { version: '0.3.1', notes: '' });
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.1' }), { version: '0.3.1', notes: '' });
  });
  test('non-string body becomes empty notes', () => {
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: 42 }), { version: '0.3.1', notes: '' });
    assert.deepEqual(parseRelease({ tag_name: 'v0.3.1', body: { a: 1 } }), { version: '0.3.1', notes: '' });
  });
  test('version is normalised without the v prefix', () => {
    assert.equal(parseRelease({ tag_name: 'v1.2.3' }).version, '1.2.3');
    assert.equal(parseRelease({ tag_name: 'v01.2.3' }).version, '1.2.3');
  });
  test('rejects pre-releases, drafts and bad tags', () => {
    assert.equal(parseRelease({ tag_name: 'v0.4.0-beta.1' }), null);
    assert.equal(parseRelease({ tag_name: 'v0.4.0', prerelease: true }), null);
    assert.equal(parseRelease({ tag_name: 'v0.4.0', draft: true }), null);
    assert.equal(parseRelease({ tag_name: 'v0.4.0', prerelease: false, draft: false }).version, '0.4.0');
    assert.equal(parseRelease({ tag_name: 'nightly' }), null);
    assert.equal(parseRelease({ tag_name: 5 }), null);
    assert.equal(parseRelease({}), null);
  });
  test('rejects non-object input', () => {
    for (const bad of [null, undefined, 'v1.2.3', 7, true, []]) assert.equal(parseRelease(bad), null, JSON.stringify(bad));
  });
});

describe('releasePageUrl', () => {
  test('points at the tag page', () => {
    assert.equal(releasePageUrl('0.3.1'), 'https://github.com/ToRexZ/mqtt-scope/releases/tag/v0.3.1');
  });
});

describe('pacmanCommand', () => {
  test('fetches that version into its own folder', () => {
    assert.equal(
      pacmanCommand('0.3.1'),
      'mkdir -p ~/.cache/mqtt-scope-pkg/0.3.1 && cd ~/.cache/mqtt-scope-pkg/0.3.1 && ' +
        'curl -fLO https://github.com/ToRexZ/mqtt-scope/releases/download/v0.3.1/PKGBUILD ' +
        '-fLO https://github.com/ToRexZ/mqtt-scope/releases/download/v0.3.1/mqtt-scope.desktop && makepkg -sic',
    );
  });
});

describe('installKind', () => {
  // A mounted AppImage: the runtime sets APPIMAGE and APPDIR, and the app runs from inside APPDIR.
  const MOUNT = { APPIMAGE: '/a/MQTT.AppImage', APPDIR: '/tmp/.mount_MQTTab' };
  const k = (o) => installKind({ platform: 'linux', env: {}, isPackaged: true, resourcesPath: '/r', execPath: '/tmp/.mount_MQTTab/mqtt-scope', exists: () => false, ...o });
  const pacmanMarker = (p) => p === path.join('/r', 'pacman-package');

  test('linux kinds', () => {
    assert.equal(k({ env: MOUNT }), 'appimage');
    assert.equal(k({ exists: pacmanMarker }), 'pacman');
    assert.equal(k({}), 'manual'); // tar.gz
  });
  test('AppImage wins over the pacman marker', () => {
    assert.equal(k({ env: MOUNT, exists: () => true }), 'appimage');
  });
  test('empty APPIMAGE is not an AppImage', () => {
    assert.equal(k({ env: { ...MOUNT, APPIMAGE: '' } }), 'manual');
  });
  test("another AppImage's APPIMAGE and APPDIR, passed on by e.g. its terminal, do not make this build an AppImage", () => {
    const leaked = { APPIMAGE: '/home/u/Applications/Cursor.AppImage', APPDIR: '/tmp/.mount_Cursor' };
    assert.equal(k({ env: leaked, execPath: '/opt/mqtt-scope/mqtt-scope' }), 'manual'); // tar.gz
    assert.equal(k({ env: leaked, execPath: '/opt/mqtt-scope/mqtt-scope', exists: pacmanMarker }), 'pacman');
    // Even an extracted AppImage of this app (AppRun next to it) started from there.
    assert.equal(k({ env: leaked, execPath: '/home/u/squashfs-root/mqtt-scope', exists: (p) => p === '/home/u/squashfs-root/AppRun' }), 'manual');
    // APPDIR only shares a prefix with the executable's folder.
    assert.equal(k({ env: { ...leaked, APPDIR: '/tmp/.mount_MQTT' }, execPath: '/tmp/.mount_MQTTab/mqtt-scope' }), 'manual');
  });
  test('APPIMAGE without APPDIR (an extracted AppImage started directly): only next to its AppRun', () => {
    const env = { APPIMAGE: '/a/MQTT.AppImage' };
    const seen = [];
    const exists = (p) => {
      seen.push(p);
      return p === '/x/squashfs-root/AppRun';
    };
    assert.equal(k({ env, execPath: '/x/squashfs-root/mqtt-scope', exists }), 'appimage');
    assert.deepEqual(seen, ['/x/squashfs-root/AppRun']);
    assert.equal(k({ env, execPath: '/opt/mqtt-scope/mqtt-scope' }), 'manual');
  });
  test('APPDIR is compared by its real path (the executable path is a real path)', () => {
    const realpath = (p) => p.replace(/^\/link\//, '/real/');
    const env = { APPIMAGE: '/a/MQTT.AppImage', APPDIR: '/link/appimage_extracted_1' };
    assert.equal(k({ env, execPath: '/real/appimage_extracted_1/mqtt-scope', realpath }), 'appimage');
    assert.equal(k({ env, execPath: '/real/appimage_extracted_1/mqtt-scope' }), 'manual');
  });
  test('pacman marker is only looked up under resourcesPath', () => {
    const seen = [];
    k({
      exists: (p) => {
        seen.push(p);
        return false;
      },
    });
    assert.deepEqual(seen, [path.join('/r', 'pacman-package')]);
  });
  test('windows kinds', () => {
    assert.equal(k({ platform: 'win32' }), 'nsis');
    assert.equal(k({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } }), 'portable');
  });
  test('other platforms are manual', () => {
    assert.equal(k({ platform: 'darwin' }), 'manual');
    assert.equal(k({ platform: 'freebsd' }), 'manual');
  });
  test('unpackaged is dev', () => {
    assert.equal(k({ isPackaged: false }), 'dev');
    assert.equal(k({ isPackaged: false, env: MOUNT }), 'dev');
  });
  test('MQTTSCOPE_UPDATE_URL makes an unpackaged build manual', () => {
    assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_URL: 'http://127.0.0.1:1' } }), 'manual');
    assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_URL: '' } }), 'dev');
  });
  test('valid MQTTSCOPE_UPDATE_KIND overrides everything', () => {
    for (const kind of ['appimage', 'nsis', 'portable', 'pacman', 'manual']) {
      assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_KIND: kind } }), kind);
      assert.equal(k({ platform: 'win32', env: { MQTTSCOPE_UPDATE_KIND: kind } }), kind);
    }
    assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_URL: 'x', MQTTSCOPE_UPDATE_KIND: 'pacman' } }), 'pacman');
  });
  test('invalid override is ignored', () => {
    assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: 'bogus' } }), 'manual');
    assert.equal(k({ isPackaged: false, env: { MQTTSCOPE_UPDATE_KIND: 'bogus' } }), 'dev');
    assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: 'dev' } }), 'manual'); // dev is not overridable
    assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: 'Pacman' } }), 'manual'); // case-sensitive
    assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: '' } }), 'manual');
    assert.equal(k({ env: { MQTTSCOPE_UPDATE_KIND: 'toString' } }), 'manual'); // no prototype lookups
  });
});
