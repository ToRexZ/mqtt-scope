// scripts/release-notes.mjs: a version's CHANGELOG section as release notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotes } from '../../scripts/release-notes.mjs';

const changelog = `# Changelog

Intro text.

## [1.1.0] - 2026-01-02

### Added

- **Thing.** A long line that
  wraps onto a second line.
- Short one.

### Fixed

- A fix
  that wraps.

## [1.0.0] - 2026-01-01

First release
over two lines.

- Feature.

[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

test('takes the section of the version, joining wrapped lines', () => {
  assert.equal(
    releaseNotes(changelog, '1.1.0'),
    '### Added\n\n- **Thing.** A long line that wraps onto a second line.\n- Short one.\n\n### Fixed\n\n- A fix that wraps.\n',
  );
});

test('the last section stops before the link definitions', () => {
  assert.equal(releaseNotes(changelog, '1.0.0'), 'First release over two lines.\n\n- Feature.\n');
});

test('an unknown version gives nothing', () => {
  assert.equal(releaseNotes(changelog, '2.0.0'), '');
  assert.equal(releaseNotes(changelog, '1.1'), '');
});

test('CHANGELOG.md has notes for the version in package.json', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const notes = releaseNotes(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), version);
  assert.ok(notes.trim(), `no CHANGELOG.md section for ${version}`);
});
