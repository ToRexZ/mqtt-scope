'use strict';

// The one request an update check makes: a plain GET for the latest release,
// with a time limit that also covers reading the body. The app adds only the
// Accept and User-Agent headers below, no identifiers or cookies; Chromium's
// net.fetch adds its standard ones (Accept-Language, Accept-Encoding,
// Sec-Fetch-*). No Electron here; main passes net.fetch.

const { LATEST_RELEASE_API } = require('./updateCheck');

const TIMEOUT_MS = 15000;

// `base` is the MQTTSCOPE_UPDATE_URL override (it serves release.json); empty means GitHub.
function releaseUrl(base) {
  return base ? `${base.replace(/\/+$/, '')}/release.json` : LATEST_RELEASE_API;
}

// Returns fetchRelease(): Promise<GitHub release JSON>, which always settles.
function createFetchRelease({ fetch, url, version, timeoutMs = TIMEOUT_MS }) {
  return async function fetchRelease() {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MQTT-Scope/${version}` }, signal });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (signal.aborted) throw new Error(`Timed out after ${timeoutMs / 1000} s`, { cause: err });
      throw err;
    }
  };
}

module.exports = { TIMEOUT_MS, releaseUrl, createFetchRelease };
