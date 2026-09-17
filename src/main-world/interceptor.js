// Runs in the page's own JS realm (manifest "world": "MAIN") so it can see the
// page's real WebSocket and fetch traffic. Passive only: never blocks, mutates,
// or drops anything — every listener is wrapped so a parsing bug here can't
// break the app.
//
// Phase 1 scope: extract the fields confirmed present during recon (see repo
// README) and relay them to the isolated-world content script via
// postMessage. No DOM scraping, no options, no storage yet.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';

  function post(fields) {
    try {
      window.postMessage({ __ccsl: 1, v: 1, type: BRIDGE_TYPE, fields }, window.location.origin);
    } catch {
      // never let a bridge failure surface to the page
    }
  }

  function extract(msg) {
    if (!msg || typeof msg !== 'object') return null;

    // CLI-protocol "system" init message. Context-window usage and branch
    // come from the session detail REST endpoint instead (see below) — it
    // has the exact used/max token counts rather than this socket's rougher
    // running estimate.
    if (msg.type === 'system' && msg.subtype === 'init') {
      return { model: msg.model };
    }

    return null;
  }

  function tap(rawData) {
    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }
    let fields = null;
    try {
      fields = extract(parsed);
    } catch {
      fields = null;
    }
    if (fields) post(fields);
  }

  // Pro/Max rate limits, confirmed via recon: /api/organizations/{id}/usage
  // returns five_hour/seven_day objects with { utilization, resets_at }.
  function extractFromUsage(json) {
    if (!json || typeof json !== 'object') return null;
    const fields = {};
    if (json.five_hour && typeof json.five_hour.utilization === 'number') {
      fields.fiveHourPct = json.five_hour.utilization;
      fields.fiveHourResetsAt = json.five_hour.resets_at || null;
    }
    if (json.seven_day && typeof json.seven_day.utilization === 'number') {
      fields.sevenDayPct = json.seven_day.utilization;
      fields.sevenDayResetsAt = json.seven_day.resets_at || null;
    }
    return Object.keys(fields).length ? fields : null;
  }

  // Session detail, confirmed via recon: GET /v1/code/sessions/{session_id}
  // (no further path segment) returns { response_shape: { config, external_metadata, ... } }
  // with everything needed for the status line in one place — including the
  // git branch, which batch-branch-status (tried earlier) never populated.
  const SESSION_DETAIL_RE = /\/v1\/code\/sessions\/(session_[^/?]+)(?:\?|$)/;
  function extractFromSessionDetail(json) {
    const r = json && json.response_shape;
    if (!r || typeof r !== 'object') return null;
    const fields = {};

    const model = r.external_metadata?.last_served_model || r.config?.model;
    if (typeof model === 'string' && model) fields.model = model;

    const branches = r.external_metadata?.current_branches;
    if (branches && typeof branches === 'object') {
      const branch = Object.values(branches).find((b) => typeof b === 'string' && b);
      if (branch) fields.branch = branch;
    }

    const ctx = r.external_metadata?.context_usage;
    if (ctx && typeof ctx.used_tokens === 'number' && typeof ctx.max_tokens === 'number' && ctx.max_tokens > 0) {
      fields.ctxUsedTokens = ctx.used_tokens;
      fields.ctxMaxTokens = ctx.max_tokens;
    }

    return Object.keys(fields).length ? fields : null;
  }

  function tapFetchResponse(url, response) {
    if (!url) return;
    try {
      if (/\/organizations\/[^/]+\/usage(\?|$)/.test(url)) {
        response.clone().json()
          .then((json) => {
            const fields = extractFromUsage(json);
            if (fields) post(fields);
          })
          .catch(() => {});
      } else if (SESSION_DETAIL_RE.test(url)) {
        response.clone().json()
          .then((json) => {
            const fields = extractFromSessionDetail(json);
            if (fields) post(fields);
          })
          .catch(() => {});
      }
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

  const OriginalWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    try {
      ws.addEventListener('message', (event) => {
        try {
          tap(event.data);
        } catch {
          // swallow — this tap must never throw into the page
        }
      });
    } catch {
      // if we can't attach the listener, just leave the page's socket alone
    }
    return ws;
  }
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  try {
    window.WebSocket = PatchedWebSocket;
  } catch {
    // if the page's CSP or an existing freeze prevents this, the isolated
    // content script simply never receives field updates and the bar shows
    // nothing — see the "UNAVAILABLE" handling in content.js
  }
})();
