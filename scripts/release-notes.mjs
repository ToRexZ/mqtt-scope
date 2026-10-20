// Prints the CHANGELOG.md section of a version, as the body of its GitHub
// release. Wrapped lines are joined, since release notes keep line breaks.
//
//   node scripts/release-notes.mjs 0.2.0 > release-notes.md

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The section of `version` in a Keep a Changelog document, or '' if missing.
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return '';
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)) break;
    const prev = out.length - 1;
    // A continuation: indented under a bullet, or more text of a paragraph.
    if (line.trim() && prev >= 0 && out[prev].trim() && !/^\s*([-*] |#)/.test(line) && !out[prev].startsWith('#')) {
      out[prev] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim() + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] || '').replace(/^v/, '');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const notes = releaseNotes(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes.trim()) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
