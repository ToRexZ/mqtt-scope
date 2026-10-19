import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decode,
  decodeBytes,
  preview,
  formatBytes,
  formatTime,
  formatDateTime,
  prettyText,
  escapeHtml,
  highlightJson,
  hexDump,
  parseHex,
  topicMatches,
  extractNumber,
} from '../../renderer/payload.js';
import { prng, enc, bytes } from './_util.mjs';

const msgOf = (payload) => ({ topic: 't', payload: typeof payload === 'string' ? enc(payload) : payload, ts: 0 });

// ------------------------------------------------------------------ decode

describe('decodeBytes', () => {
  test('empty payloads (zero length, null, undefined)', () => {
    for (const b of [new Uint8Array(0), null, undefined]) {
      assert.deepEqual(decodeBytes(b), { kind: 'empty', text: '', size: 0 });
    }
  });

  test('json objects and arrays, with surrounding whitespace', () => {
    assert.deepEqual(decodeBytes(enc('{"a":1}')), { kind: 'json', text: '{"a":1}', value: { a: 1 }, size: 7 });
    const d = decodeBytes(enc(' \n\t[1, 2, {"b": null}]  \r\n'));
    assert.equal(d.kind, 'json');
    assert.deepEqual(d.value, [1, 2, { b: null }]);
    assert.equal(d.text, ' \n\t[1, 2, {"b": null}]  \r\n', 'text is the untrimmed original');
    assert.deepEqual(decodeBytes(enc('{}')).value, {});
    assert.deepEqual(decodeBytes(enc('[]')).value, []);
  });

  test('a UTF-8 BOM before JSON does not prevent parsing', () => {
    const d = decodeBytes(bytes(0xef, 0xbb, 0xbf, ...enc('{"a":1}')));
    assert.equal(d.kind, 'json');
    assert.deepEqual(d.value, { a: 1 });
    assert.equal(d.size, 10);
  });

  test('JSON-looking but invalid input is text, not json, and keeps its text', () => {
    for (const s of ['{abc', '[1,2,', '{"a":1} trailing', '{"a":1,}', "{'a':1}", '[', '{']) {
      const d = decodeBytes(enc(s));
      assert.equal(d.kind, 'text', s);
      assert.equal(d.text, s);
      assert.equal(d.value, undefined);
    }
  });

  test('JSON scalars at top level are not classified as json', () => {
    assert.equal(decodeBytes(enc('"str"')).kind, 'text');
    assert.equal(decodeBytes(enc('true')).kind, 'text');
    assert.equal(decodeBytes(enc('null')).kind, 'text');
  });

  test('plain decimal numbers', () => {
    const cases = [
      ['42', 42],
      ['-3.5', -3.5],
      ['0', 0],
      ['1e3', 1000],
      ['-2.5E-3', -0.0025],
      ['.5', 0.5],
      ['  42 \n', 42],
      ['\t7\r\n', 7],
    ];
    for (const [s, v] of cases) {
      const d = decodeBytes(enc(s));
      assert.equal(d.kind, 'number', JSON.stringify(s));
      assert.equal(d.value, v, JSON.stringify(s));
      assert.equal(d.text, s, 'text keeps original whitespace');
    }
  });

  test('non-finite and non-numeric strings are text', () => {
    for (const s of ['NaN', 'Infinity', '-Infinity', '1e400', '1,000', '12abc', '1 2', '   ', '\n', '--1', '1_000']) {
      assert.equal(decodeBytes(enc(s)).kind, 'text', JSON.stringify(s));
    }
  });

  test('JS-only numeric literals (hex/octal/binary) are text, not numbers', () => {
    // Number('0x10') === 16 but '-0x10' is NaN; a hex string payload is not a
    // decimal number and must not be plotted as 16.
    for (const s of ['0x10', '0b101', '0o17']) {
      assert.equal(decodeBytes(enc(s)).kind, 'text', JSON.stringify(s));
    }
    assert.equal(decodeBytes(enc('-0x10')).kind, 'text');
  });

  test('invalid UTF-8 is binary with null text', () => {
    const cases = [
      bytes(0xff),
      bytes(0xc3, 0x28), // bad continuation
      bytes(0xc0, 0xaf), // overlong
      bytes(0xed, 0xa0, 0x80), // encoded surrogate
      bytes(0x61, 0xe2, 0x82), // truncated tail
    ];
    for (const b of cases) {
      assert.deepEqual(decodeBytes(b), { kind: 'binary', text: null, size: b.length });
    }
  });

  test('control characters mark binary; tab/newline/CR do not', () => {
    for (const c of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f]) {
      assert.equal(decodeBytes(bytes(0x61, c, 0x62)).kind, 'binary', `0x${c.toString(16)}`);
    }
    assert.equal(decodeBytes(enc('a\tb\nc\r\n')).kind, 'text');
    // A JSON document with a NUL inside is binary, not json.
    assert.equal(decodeBytes(enc('{"a":"\u0000"}')).kind, 'binary');
  });

  test('only the first 4096 characters are scanned for control chars (documented trade-off)', () => {
    assert.equal(decodeBytes(enc('a'.repeat(4095) + '\u0001')).kind, 'binary');
    assert.equal(decodeBytes(enc('a'.repeat(4096) + '\u0001')).kind, 'text');
  });

  test('size is the byte length, not the character length', () => {
    const d = decodeBytes(enc('€😀'));
    assert.equal(d.kind, 'text');
    assert.equal(d.size, 7);
    assert.equal(d.text, '€😀');
  });

  test('multibyte JSON round-trips', () => {
    const d = decodeBytes(enc('{"ключ":"值😀"}'));
    assert.deepEqual(d.value, { ключ: '值😀' });
  });
});

describe('decode', () => {
  test('caches the result on msg._decoded', () => {
    const msg = msgOf('{"a":1}');
    const d1 = decode(msg);
    assert.equal(msg._decoded, d1);
    msg.payload = enc('changed'); // cache wins even if the payload were swapped
    assert.equal(decode(msg), d1);
    assert.equal(decode(msg).kind, 'json');
  });

  test('uses an existing cache entry without touching the payload', () => {
    const cached = { kind: 'text', text: 'x', size: 1 };
    assert.equal(decode({ payload: null, _decoded: cached }), cached);
  });
});

// ------------------------------------------------------------------ preview

describe('preview', () => {
  test('empty payload', () => {
    assert.equal(preview(msgOf(new Uint8Array(0))), '(empty)');
    assert.equal(preview({ payload: null }), '(empty)');
  });

  test('collapses all whitespace runs to single spaces and trims', () => {
    assert.equal(preview(msgOf('  a\n\n  b\t\tc\r\n d  ')), 'a b c d');
  });

  test('truncates to max (default 160)', () => {
    const msg = msgOf('x'.repeat(500));
    assert.equal(preview(msg).length, 160);
    assert.equal(preview(msg, 10), 'x'.repeat(10));
    assert.equal(preview(msg, 0), '');
    assert.equal(preview(msg, 10_000).length, 500);
  });

  test('internal preview is capped at 1000 characters', () => {
    const msg = msgOf('y'.repeat(5000));
    assert.equal(preview(msg, 100_000).length, 1000);
  });

  test('caches on msg._preview and slices the cache for later calls', () => {
    const msg = msgOf('hello world');
    assert.equal(preview(msg, 5), 'hello');
    assert.equal(msg._preview, 'hello world');
    msg.payload = enc('other');
    assert.equal(preview(msg), 'hello world');
  });

  test('binary label for control chars and invalid UTF-8', () => {
    assert.equal(preview(msgOf(bytes(0, 1, 2))), '<binary 3 B>');
    assert.equal(preview(msgOf(bytes(0xff, 0xfe))), '<binary 2 B>');
    assert.equal(preview(msgOf(new Uint8Array(2 * 1024 * 1024))), '<binary 2.00 MB>');
  });

  test('a multi-byte character cut by the 2048-byte slice is not reported as binary', () => {
    for (const ch of ['é', '€', '😀']) {
      const chLen = enc(ch).length;
      for (let pad = 2048 - chLen; pad <= 2048; pad++) {
        const msg = msgOf('a'.repeat(pad) + ch + 'tail');
        const p = preview(msg, 5000);
        assert.ok(!p.startsWith('<binary'), `char ${ch} at byte offset ${pad}`);
        assert.ok(p.startsWith('aaaa'));
      }
    }
  });

  test('a truncated multi-byte sequence at the true end of a short payload is binary (consistent with decode)', () => {
    // 'a' + first two bytes of '€': not valid UTF-8; decode() says binary.
    const msg = msgOf(bytes(0x61, 0xe2, 0x82));
    assert.equal(decodeBytes(msg.payload).kind, 'binary');
    assert.equal(preview(msg), '<binary 3 B>');
  });

  test('a huge payload is neither fully decoded nor JSON-parsed', (t) => {
    const big = enc('{"data":"' + 'x'.repeat(8 * 1024 * 1024) + '"}');
    const msg = msgOf(big);
    const decodeLens = [];
    const origDecode = TextDecoder.prototype.decode;
    const origParse = JSON.parse;
    let parsed = 0;
    TextDecoder.prototype.decode = function (input, opts) {
      decodeLens.push(input ? input.byteLength : 0);
      return origDecode.call(this, input, opts);
    };
    JSON.parse = (...a) => {
      parsed++;
      return origParse(...a);
    };
    let p;
    try {
      p = preview(msg);
    } finally {
      TextDecoder.prototype.decode = origDecode;
      JSON.parse = origParse;
    }
    assert.equal(parsed, 0);
    assert.ok(decodeLens.length >= 1);
    assert.ok(Math.max(...decodeLens) <= 2048, `decoded ${Math.max(...decodeLens)} bytes`);
    assert.equal(msg._decoded, undefined);
    assert.ok(p.startsWith('{"data":"xxx'));
  });

  test('control chars beyond the first 2048 bytes do not affect the preview', () => {
    const msg = msgOf('a'.repeat(3000) + '\u0001');
    assert.equal(preview(msg), 'a'.repeat(160));
  });
});

// ------------------------------------------------------------------ formatting

describe('formatBytes', () => {
  test('bytes, KB and MB boundaries', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.00 MB');
    assert.equal(formatBytes(5.5 * 1024 * 1024), '5.50 MB');
  });

  test('values just below 1 MB do not render as "1024.0 KB"', () => {
    // 1048575 / 1024 = 1023.999 -> toFixed(1) rounds up to "1024.0".
    const s = formatBytes(1024 * 1024 - 1);
    assert.notEqual(s, '1024.0 KB');
    assert.ok(s === '1.00 MB' || /^10[0-2]\d\.\d KB$/.test(s), s);
  });
});

function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe('formatTime / formatDateTime', () => {
  test('formatTime pads hours, minutes, seconds and milliseconds (local time)', () => {
    assert.equal(formatTime(new Date(2024, 0, 2, 3, 4, 5, 6).getTime()), '03:04:05.006');
    assert.equal(formatTime(new Date(2024, 11, 31, 23, 59, 59, 999).getTime()), '23:59:59.999');
    assert.equal(formatTime(new Date(2024, 5, 1, 0, 0, 0, 0).getTime()), '00:00:00.000');
  });

  test('formatDateTime in UTC', () => {
    withTZ('UTC', () => {
      assert.equal(formatDateTime(Date.UTC(2024, 1, 29, 13, 5, 9, 42)), '2024-02-29 13:05:09.042');
    });
  });

  test('formatDateTime: date and time use the same (local) timezone, west of UTC', () => {
    withTZ('America/New_York', () => {
      // 2024-01-02T03:00Z is 2024-01-01 22:00 in New York.
      assert.equal(formatDateTime(Date.UTC(2024, 0, 2, 3, 0, 0, 0)), '2024-01-01 22:00:00.000');
    });
  });

  test('formatDateTime: date and time use the same (local) timezone, east of UTC', () => {
    withTZ('Asia/Tokyo', () => {
      // 2024-01-01T20:00Z is 2024-01-02 05:00 in Tokyo.
      assert.equal(formatDateTime(Date.UTC(2024, 0, 1, 20, 0, 0, 0)), '2024-01-02 05:00:00.000');
    });
  });
});

describe('prettyText', () => {
  test('json is pretty-printed with 2 spaces and cached on the decoded object', () => {
    const d = decodeBytes(enc('{"a":[1,{"b":null}]}'));
    const p = prettyText(d);
    assert.equal(p, '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}');
    assert.equal(d._pretty, p);
    d.value = { changed: true };
    assert.equal(prettyText(d), p, 'cached');
  });

  test('non-json kinds return their text, binary/empty return empty string', () => {
    assert.equal(prettyText(decodeBytes(enc(' 42 '))), ' 42 ');
    assert.equal(prettyText(decodeBytes(enc('hi'))), 'hi');
    assert.equal(prettyText(decodeBytes(bytes(0))), '');
    assert.equal(prettyText(decodeBytes(new Uint8Array(0))), '');
  });
});

// ------------------------------------------------------------------ HTML

describe('escapeHtml', () => {
  test('escapes all five significant characters', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  });
  test('leaves other text untouched', () => {
    assert.equal(escapeHtml('plain € 😀 \\ / `'), 'plain € 😀 \\ / `');
    assert.equal(escapeHtml(''), '');
  });
});

const TOKEN_TAG = /<span class="tk-(?:key|str|num|bool|null)">|<\/span>/g;
const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Asserts `html` contains only our token spans plus escaped text, and that its
// text content equals `input`.
function assertSafeHighlight(html, input) {
  const stripped = html.replace(TOKEN_TAG, '');
  assert.ok(!/[<>"']/.test(stripped), `unescaped markup in: ${stripped.slice(0, 200)}`);
  assert.ok(!/&(?!(?:lt|gt|quot|#39|amp);)/.test(stripped), 'bare ampersand');
  assert.equal(unescape(stripped), input);
}

describe('highlightJson', () => {
  test('token classes for keys, strings, numbers, booleans and null', () => {
    const text = JSON.stringify({ k: 'v', n: -1.5e-7, i: 42, t: true, f: false, z: null, a: [0] }, null, 2);
    const html = highlightJson(text);
    assert.match(html, /<span class="tk-key">&quot;k&quot;<\/span>:/);
    assert.match(html, /<span class="tk-str">&quot;v&quot;<\/span>/);
    assert.match(html, /<span class="tk-num">-1\.5e-7<\/span>/);
    assert.match(html, /<span class="tk-num">42<\/span>/);
    assert.match(html, /<span class="tk-bool">true<\/span>/);
    assert.match(html, /<span class="tk-bool">false<\/span>/);
    assert.match(html, /<span class="tk-null">null<\/span>/);
    assert.match(html, /<span class="tk-num">0<\/span>/);
    assertSafeHighlight(html, text);
  });

  test('key detection allows whitespace before the colon', () => {
    assert.equal(highlightJson('{"a"  : 1}'), '{<span class="tk-key">&quot;a&quot;</span>  : <span class="tk-num">1</span>}');
  });

  test('escaped quotes and backslashes stay inside a single string token', () => {
    const text = JSON.stringify({ 'k"ey': 'va"l\\ue', end: '\\' });
    const html = highlightJson(text);
    assert.match(html, /<span class="tk-key">&quot;k\\&quot;ey&quot;<\/span>:/);
    assert.match(html, /<span class="tk-str">&quot;va\\&quot;l\\\\ue&quot;<\/span>/);
    assert.match(html, /<span class="tk-str">&quot;\\\\&quot;<\/span>/);
    assertSafeHighlight(html, text);
  });

  test('payload markup is escaped (XSS)', () => {
    const evil = {
      '<script>alert(1)</script>': '<img src=x onerror="alert(2)">',
      "'&quot;": ['</span><b>', '&lt;already&gt;', 'a & b'],
      nested: { '"><svg/onload=alert(3)>': true },
    };
    const text = JSON.stringify(evil, null, 2);
    const html = highlightJson(text);
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<svg'));
    assert.ok(!html.includes('<b>'));
    assertSafeHighlight(html, text);
  });

  test('arbitrary non-JSON text is escaped (fuzz)', () => {
    const r = prng(1234);
    const alphabet = ['<', '>', '&', '"', "'", '\\', ':', '{', '}', '[', ']', ',', ' ', '\n', 'a', 'true', 'null', '-1.5e3', '7', 'é', '😀', '<script>'];
    for (let i = 0; i < 500; i++) {
      let s = '';
      const n = r.int(0, 40);
      for (let j = 0; j < n; j++) s += r.pick(alphabet);
      assertSafeHighlight(highlightJson(s), s);
    }
  });

  test('an unterminated string is escaped as plain text', () => {
    const html = highlightJson('"abc <b>');
    assert.equal(html, '&quot;abc &lt;b&gt;');
  });

  test('inputs over 1.5 MB fall back to escaped plain text', () => {
    const big = '{"k":"<x>' + 'a'.repeat(1_500_000) + '"}';
    const html = highlightJson(big);
    assert.ok(!html.includes('<span'));
    assert.ok(html.startsWith('{&quot;k&quot;:&quot;&lt;x&gt;aaa'));
    assert.equal(unescape(html), big);
  });

  test('inputs of exactly 1.5 MB are still highlighted', () => {
    const s = '"' + 'a'.repeat(1_500_000 - 2) + '"';
    assert.equal(s.length, 1_500_000);
    assert.ok(highlightJson(s).startsWith('<span class="tk-str">'));
  });

  test('empty input', () => {
    assert.equal(highlightJson(''), '');
  });
});

// ------------------------------------------------------------------ hex

describe('hexDump', () => {
  test('full lines: offset, two hex groups, ascii column', () => {
    const b = Uint8Array.from({ length: 16 }, (_, i) => 0x41 + i);
    assert.equal(hexDump(b), '00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  ABCDEFGHIJKLMNOP');
  });

  test('non-printable bytes show as dots; space and tilde are printable', () => {
    const b = bytes(0x00, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0xff, 0x0a);
    const line = hexDump(b);
    assert.ok(line.endsWith(' .. ~....'), line);
  });

  test('partial last line is padded so the ascii column stays aligned', () => {
    const b = Uint8Array.from({ length: 18 }, (_, i) => i + 0x30);
    const lines = hexDump(b).split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith('00000010  40 41 '));
    const asciiCol = lines[0].length - 16;
    assert.equal(lines[1].slice(asciiCol), '@A');
    assert.equal(lines[1].length, asciiCol + 2);
    // Single byte
    const one = hexDump(bytes(0x41));
    assert.equal(one.slice(asciiCol), 'A');
    assert.ok(one.startsWith('00000000  41 '));
  });

  test('exactly 8 bytes keeps the group gap', () => {
    const line = hexDump(Uint8Array.from({ length: 8 }, () => 0x61));
    assert.equal(line, '00000000  61 61 61 61 61 61 61 61  ' + ' '.repeat(24) + ' aaaaaaaa');
  });

  test('offsets increase by 0x10 and are 8 hex digits', () => {
    const b = new Uint8Array(16 * 300 + 5);
    const lines = hexDump(b).split('\n');
    assert.equal(lines.length, 301);
    lines.forEach((l, i) => assert.equal(l.slice(0, 10), (i * 16).toString(16).padStart(8, '0') + '  '));
  });

  test('empty input gives empty output', () => {
    assert.equal(hexDump(new Uint8Array(0)), '');
  });

  test('maxBytes truncation adds a note with the remaining size', () => {
    const lines = hexDump(new Uint8Array(40), 16).split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '… 24 B more');
    const big = hexDump(new Uint8Array(65536 + 2048)).split('\n');
    assert.equal(big.length, 4096 + 1);
    assert.equal(big.at(-1), '… 2.0 KB more');
    assert.equal(big.at(-2).slice(0, 8), '0000fff0');
  });

  test('maxBytes not on a 16-byte boundary', () => {
    const lines = hexDump(Uint8Array.from({ length: 30 }, () => 0x61), 20).split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].endsWith(' aaaa'));
    assert.equal(lines[2], '… 10 B more');
  });

  test('maxBytes = Infinity dumps everything with no note', () => {
    const s = hexDump(new Uint8Array(70000), Infinity);
    assert.ok(!s.includes('more'));
    assert.equal(s.split('\n').length, Math.ceil(70000 / 16));
  });
});

describe('parseHex', () => {
  test('plain, spaced, mixed case', () => {
    assert.deepEqual(parseHex('deadbeef'), bytes(0xde, 0xad, 0xbe, 0xef));
    assert.deepEqual(parseHex('de ad  be\tef\n'), bytes(0xde, 0xad, 0xbe, 0xef));
    assert.deepEqual(parseHex('DeAdBeEf'), bytes(0xde, 0xad, 0xbe, 0xef));
  });

  test('0x prefixes (either case) and common separators', () => {
    assert.deepEqual(parseHex('0xDE 0Xad,0xbe:0xEF'), bytes(0xde, 0xad, 0xbe, 0xef));
    assert.deepEqual(parseHex('00-01-ff'), bytes(0, 1, 255));
  });

  test('empty input gives an empty array', () => {
    assert.deepEqual(parseHex(''), new Uint8Array(0));
    assert.deepEqual(parseHex('   '), new Uint8Array(0));
  });

  test('odd number of digits throws', () => {
    assert.throws(() => parseHex('abc'), /Odd number of hex digits/);
    assert.throws(() => parseHex('0x1'), /Odd/);
  });

  test('round-trips with hexDump-style formatting of every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = Array.from(all, (b) => b.toString(16).padStart(2, '0')).join(' ');
    assert.deepEqual(parseHex(text), all);
    assert.deepEqual(parseHex(text.toUpperCase()), all);
  });

  test('non-hex characters are rejected rather than silently dropped', () => {
    // 'hello' would otherwise become the single byte 0xED; 'zz' an empty payload.
    assert.throws(() => parseHex('hello'));
    assert.throws(() => parseHex('zz'));
    assert.throws(() => parseHex('0g'));
  });
});

// ------------------------------------------------------------------ topics

describe('topicMatches', () => {
  const yes = (f, t) => assert.equal(topicMatches(f, t), true, `${f} should match ${t}`);
  const no = (f, t) => assert.equal(topicMatches(f, t), false, `${f} should not match ${t}`);

  test('exact filters', () => {
    yes('a/b', 'a/b');
    no('a/b', 'a/c');
    no('a', 'a/b');
    no('a/b', 'a');
    no('A', 'a');
    no('a/b', 'a/b/');
    yes('a', 'a');
  });

  test('# matches everything at and below its level', () => {
    yes('#', 'a');
    yes('#', 'a/b/c');
    yes('#', '/a');
    yes('a/#', 'a/b');
    yes('a/#', 'a/b/c/d');
    no('a/#', 'b/a');
    no('a/#', 'ab');
    no('a/b/#', 'a');
  });

  test('"a/#" also matches the parent level "a" (MQTT spec 4.7.1.2)', () => {
    yes('a/#', 'a');
    yes('sport/tennis/player1/#', 'sport/tennis/player1');
    yes('a/+/#', 'a/b');
  });

  test('+ matches exactly one level, including an empty one', () => {
    yes('+', 'a');
    no('+', 'a/b');
    no('+', '/a');
    yes('+/+', '/a');
    yes('/+', '/a');
    yes('a/+', 'a/');
    no('a/+', 'a');
    yes('+/b', 'a/b');
    yes('a/+/c', 'a/b/c');
    no('a/+/c', 'a/b/d');
    no('a/+/c', 'a/b/c/d');
    yes('+/+/+', 'a/b/c');
    yes('+/#', 'a');
    yes('+/#', 'a/b/c');
  });

  test('empty levels are significant', () => {
    yes('a//b', 'a//b');
    yes('a/+/b', 'a//b');
    no('a/b', 'a//b');
    yes('/a', '/a');
    no('a', '/a');
  });

  test('$-prefixed topics are not matched by leading wildcards (MQTT spec 4.7.2)', () => {
    no('#', '$SYS/broker/uptime');
    no('+/broker/uptime', '$SYS/broker/uptime');
    no('+', '$SYS');
    yes('$SYS/#', '$SYS/broker/uptime');
    yes('$SYS/+/uptime', '$SYS/broker/uptime');
    // A '$' later in the topic is not special.
    yes('#', 'a/$b');
    yes('a/+', 'a/$b');
  });
});

// ------------------------------------------------------------------ numbers

describe('extractNumber', () => {
  const n = (payload, segs) => extractNumber(msgOf(payload), segs);

  test('plain numeric payloads', () => {
    assert.equal(n('42'), 42);
    assert.equal(n(' -1.25 \n'), -1.25);
    assert.equal(n('1e3'), 1000);
    assert.equal(n('0', null), 0);
    assert.equal(n('7', []), 7);
  });

  test('non-numeric payloads are undefined', () => {
    for (const p of ['abc', '', 'NaN', 'Infinity', '1e400', 'true']) assert.equal(n(p), undefined, p);
    assert.equal(n(bytes(0, 1, 2)), undefined);
    assert.equal(n('{"a":1}'), undefined, 'a JSON object is not a number');
    assert.equal(n('[1]'), undefined);
  });

  test('JSON paths into objects and arrays', () => {
    const p = '{"a":{"b":[10,{"c":3.5}]},"s":" 12 ","t":true,"f":false,"z":null,"e":"","x":"abc","big":1e400,"inf":"Infinity","neg":"-2e-3"}';
    assert.equal(n(p, ['a', 'b', 0]), 10);
    assert.equal(n(p, ['a', 'b', 1, 'c']), 3.5);
    assert.equal(n(p, ['s']), 12, 'numeric strings are accepted');
    assert.equal(n(p, ['neg']), -0.002);
    assert.equal(n(p, ['t']), 1);
    assert.equal(n(p, ['f']), 0);
    assert.equal(n(p, ['z']), undefined);
    assert.equal(n(p, ['e']), undefined);
    assert.equal(n(p, ['x']), undefined);
    assert.equal(n(p, ['big']), undefined, 'JSON 1e400 parses to Infinity');
    assert.equal(n(p, ['inf']), undefined);
    assert.equal(n(p, ['a']), undefined, 'object');
    assert.equal(n(p, ['a', 'b']), undefined, 'array');
  });

  test('missing paths and paths through primitives/null are undefined', () => {
    const p = '{"a":{"b":1},"z":null,"s":"str"}';
    assert.equal(n(p, ['missing']), undefined);
    assert.equal(n(p, ['a', 'missing']), undefined);
    assert.equal(n(p, ['a', 'b', 'deeper']), undefined);
    assert.equal(n(p, ['z', 'x']), undefined);
    assert.equal(n(p, ['s', 0]), undefined);
    assert.equal(n('[5,6]', [5]), undefined);
    assert.equal(n('[5,6]', [1]), 6);
  });

  test('a path on a non-JSON payload is undefined', () => {
    assert.equal(n('42', ['a']), undefined);
    assert.equal(n('text', ['a']), undefined);
  });

  test('top-level boolean inside JSON array path', () => {
    assert.equal(n('[true,false]', [0]), 1);
    assert.equal(n('[true,false]', [1]), 0);
  });

  test('hex-looking strings are not decimal numbers', () => {
    assert.equal(n('0x10'), undefined);
    assert.equal(n('{"v":"0x10"}', ['v']), undefined);
  });

  test('uses and populates the decode cache', () => {
    const msg = msgOf('{"v":2}');
    assert.equal(extractNumber(msg, ['v']), 2);
    assert.ok(msg._decoded);
    msg._decoded = { kind: 'number', value: 99, text: '99', size: 2 };
    assert.equal(extractNumber(msg, null), 99);
  });
});


describe('hasUnsafeIntegers / unsafeJson / searchableText', () => {
  const P = () => import('../../renderer/payload.js');
  test('flags integers beyond 2^53 outside strings only', async () => {
    const { hasUnsafeIntegers } = await P();
    const yes = ['{"id":9007199254740993}', '[0,12345678901234567890]', '{"t":-18446744073709551615}', '{"n":12345678901234567}'];
    const no = ['{"id":9007199254740991}', '{"s":"12345678901234567890"}', '[1.234567890123456789]', '{"a":"x\\"12345678901234567890"}', '{"e":1e-12345678901234567}', '{"f":12345678901234567.5}', '[]'];
    for (const t of yes) assert.equal(hasUnsafeIntegers(t), true, t);
    for (const t of no) assert.equal(hasUnsafeIntegers(t), false, t);
  });
  test('unsafeJson is cached and false for non-JSON', async () => {
    const { decode, unsafeJson } = await P();
    const d = decode({ payload: new TextEncoder().encode('{"id":18446744073709551615}') });
    assert.equal(unsafeJson(d), true);
    assert.equal(d._unsafe, true);
    assert.equal(unsafeJson(decode({ payload: new TextEncoder().encode('18446744073709551615') })), false);
  });
  test('searchableText covers the whole payload, lower-cased, and is empty for binary', async () => {
    const { searchableText } = await P();
    const long = JSON.stringify({ pad: 'x'.repeat(10000), errors: [{ errorType: 'LaserScannerWarning' }] });
    assert.ok(searchableText({ payload: new TextEncoder().encode(long) }).includes('laserscannerwarning'));
    assert.equal(searchableText({ payload: new Uint8Array([0, 1, 2]) }), '');
    assert.equal(searchableText({ payload: new Uint8Array() }), '');
  });
});
