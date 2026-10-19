'use strict';

// Minimal file logger: <userData>/logs/main.log, rotated at 2 MB.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
let file = null;

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'main.log');
}

function write(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  if (level === 'ERROR') process.stderr.write(line);
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, line);
  } catch {
    // Logging must never take the app down.
  }
}

module.exports = {
  init,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  get file() {
    return file;
  },
};
