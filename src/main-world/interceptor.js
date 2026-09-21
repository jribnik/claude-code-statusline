// Runs in the page's own JS realm (manifest "world": "MAIN") so it can see the
// page's real fetch traffic. Passive only: never blocks, mutates, or drops
// anything — every listener is wrapped so a parsing bug here can't break the app.
//
// Field extraction (which URLs to tap, where fields live in their JSON) is
// declarative — see src/shared/selector-pack.js, loaded just before this
// file in manifest.json. When claude.ai changes a response shape, patch a
// `path` string there; this file only wires taps to CCSL_PACK.extract() and
// relays results to the isolated world via postMessage.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';
  const DRIFT_TYPE = '__ccsl_drift';

  const PACK = globalThis.CCSL_PACK;
  delete globalThis.CCSL_PACK; // don't leave extension internals on the page's own window

  if (!PACK) {
    console.warn('[claude-code-statusline] selector pack failed to load; extension inactive');
    return;
  }

  function post(type, payload) {
    try {
      window.postMessage({ __ccsl: 1, v: 1, type, ...payload }, window.location.origin);
    } catch {
      // never let a bridge failure surface to the page
    }
  }

  // One console.warn (and one bridge post) per distinct drift signature per
  // page load, so a repeatedly-polled endpoint (e.g. /usage) doesn't spam.
  const warnedDrift = new Set();

  function reportDrift(endpoint, items) {
    const fresh = items.filter((item) => {
      const sig = `${PACK.version}|${endpoint.id}|${item.key || '(root)'}|${item.sawAt}`;
      if (warnedDrift.has(sig)) return false;
      warnedDrift.add(sig);
      return true;
    });
    if (!fresh.length) return;

    for (const item of fresh) {
      console.warn(
        `[claude-code-statusline] selector pack v${PACK.version} drift: ${endpoint.id}.${item.key || '(root)'} `
          + `— expected ${item.path || item.anchor}, saw ${item.saw} at ${item.sawAt}`
      );
    }
    post(DRIFT_TYPE, {
      packVersion: PACK.version,
      items: fresh.map((item) => ({ endpoint: endpoint.id, key: item.key })),
    });
  }

  function tapFetchResponse(url, response) {
    if (!url) return;
    const endpoint = PACK.matchEndpoint(url);
    if (!endpoint) return;
    try {
      response.clone().json()
        .then((json) => {
          const { fields, drift } = PACK.extract(endpoint, json);
          if (fields) post(BRIDGE_TYPE, { fields });
          if (drift.length) reportDrift(endpoint, drift);
        })
        .catch(() => {});
    } catch {
      // never let a tap failure affect the response the page actually uses
    }
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        tapFetchResponse(url, response);
      } catch {
        // swallow — the page must always get its real response back
      }
      return response;
    };
  }
})();
