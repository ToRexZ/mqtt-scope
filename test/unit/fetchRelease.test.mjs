// The latest-release request: where it goes, what it sends, and that its time
// limit covers a server that stalls before or during the body. Runs Node's
// fetch against a local server (same WHATWG semantics as Electron's net.fetch).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requireFromRoot } from './_util.mjs';

const { releaseUrl, createFetchRelease, TIMEOUT_MS } = requireFromRoot('./main/fetchRelease.js');
const { LATEST_RELEASE_API } = requireFromRoot('./main/updateCheck.js');

// path -> handler(req, res); every request is recorded.
const routes = {
  '/release.json': (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"tag_name":"v9.9.9","body":"x"}'),
  '/broken.json': (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"tag_name":'),
  '/limited': (_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"API rate limit exceeded"}'),
  '/stall-head': () => {},
  '/stall-body': (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"tag_name":');
  },
};
const seen = [];
const server = createServer((req, res) => {
  seen.push(req);
  routes[req.url](req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const fetchFrom = (path, timeoutMs) => createFetchRelease({ fetch, url: `${base}${path}`, version: '1.2.3', timeoutMs });

describe('releaseUrl', () => {
  test('GitHub unless the override is set', () => {
    for (const none of [undefined, null, '']) assert.equal(releaseUrl(none), LATEST_RELEASE_API);
  });

  test('the override serves release.json, with or without a trailing slash', () => {
    assert.equal(releaseUrl('http://127.0.0.1:5000'), 'http://127.0.0.1:5000/release.json');
    assert.equal(releaseUrl('http://127.0.0.1:5000/feed/'), 'http://127.0.0.1:5000/feed/release.json');
    assert.equal(releaseUrl('http://127.0.0.1:5000//'), 'http://127.0.0.1:5000/release.json');
  });
});

describe('createFetchRelease', () => {
  test('a plain GET with only Accept, User-Agent and a time limit', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.0' }) };
    };
    const fetchRelease = createFetchRelease({ fetch: fakeFetch, url: 'https://example.invalid/r', version: '0.3.0' });
    assert.deepEqual(await fetchRelease(), { tag_name: 'v1.0.0' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://example.invalid/r');
    assert.deepEqual(Object.keys(init).sort(), ['headers', 'signal']);
    assert.deepEqual(init.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'MQTT-Scope/0.3.0' });
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('returns the release JSON; the headers arrive as sent', async () => {
    assert.deepEqual(await fetchFrom('/release.json')(), { tag_name: 'v9.9.9', body: 'x' });
    const req = seen.at(-1);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['user-agent'], 'MQTT-Scope/1.2.3');
    assert.equal(req.headers.accept, 'application/vnd.github+json');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
  });

  test('a non-2xx answer is an error naming the status, and its body is not read', async () => {
    await assert.rejects(fetchFrom('/limited')(), { message: 'HTTP 403' });
    let cancelled = 0;
    let read = 0;
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      body: { cancel: async () => void cancelled++ },
      json: async () => void read++,
    });
    await assert.rejects(createFetchRelease({ fetch: fakeFetch, url: 'u', version: '1' })(), { message: 'HTTP 503' });
    assert.deepEqual({ cancelled, read }, { cancelled: 1, read: 0 });
  });

  test('a body that is not JSON rejects', async () => {
    await assert.rejects(fetchFrom('/broken.json')(), SyntaxError);
  });

  test('the time limit covers a server that never answers', { timeout: 5000 }, async () => {
    const t0 = Date.now();
    await assert.rejects(fetchFrom('/stall-head', 150)(), { message: 'Timed out after 0.15 s' });
    assert.ok(Date.now() - t0 < 2000);
  });

  test('the time limit covers a body that stops halfway', { timeout: 5000 }, async () => {
    const t0 = Date.now();
    await assert.rejects(fetchFrom('/stall-body', 150)(), { message: 'Timed out after 0.15 s' });
    assert.ok(Date.now() - t0 < 2000);
  });

  test('network errors pass through unchanged', async () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED');
    const fetchRelease = createFetchRelease({ fetch: async () => Promise.reject(err), url: 'u', version: '1' });
    await assert.rejects(fetchRelease(), (e) => e === err);
  });

  test('the default time limit is 15 s', () => {
    assert.equal(TIMEOUT_MS, 15000);
  });
});
