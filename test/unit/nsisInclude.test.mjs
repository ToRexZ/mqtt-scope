// The Windows installer's update behaviour (build/installer.nsh) is part of
// the updater's contract with every installed version: from 0.3.0 on, each
// version's installer is run with its window by the version before it, so
// the include must stay in the build and keep the hooks electron-builder's
// templates call (app-builder-lib/templates/nsis: multiUserUi.nsh,
// assistedInstaller.nsh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_util.mjs';

test('the NSIS include stays in the build config and defines the hooks electron-builder calls', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  const nsh = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /^\s*!macro customInstallMode$/m);
  assert.match(nsh, /^\s*!macro customFinishPage$/m);
});

test('the templates of this electron-builder still call those hooks', () => {
  const templates = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  assert.match(readFileSync(path.join(templates, 'multiUserUi.nsh'), 'utf8'), /!insertmacro customInstallMode/);
  assert.match(readFileSync(path.join(templates, 'assistedInstaller.nsh'), 'utf8'), /!insertmacro customFinishPage/);
});
