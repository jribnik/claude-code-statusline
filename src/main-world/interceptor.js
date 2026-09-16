// Runs in the page's own JS realm (manifest "world": "MAIN") so it can see the
// page's real WebSocket traffic. Passive only: never blocks, mutates, or drops
// a message — every listener is wrapped so a parsing bug here can't break the app.
//
// Phase 1 scope: extract the fields confirmed present during recon (see repo
// README) from the session WebSocket and relay them to the isolated-world
// content script via postMessage. No DOM scraping, no options, no storage yet.

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

    // CLI-protocol "system" init message.
    if (msg.type === 'system' && msg.subtype === 'init') {
      return { model: msg.model };
    }

    // Context-window / autocompact state.
    if (msg.type === 'autocompact_state' && msg.value && typeof msg.value === 'object') {
      return {
        effectiveWindow: msg.value.effective_window,
        autocompactThreshold: msg.value.threshold,
      };
    }

    // Running token estimate — matched structurally since the exact "type"
    // enum value wasn't captured during recon; presence of both fields is
    // distinctive enough.
    if (typeof msg.estimated_tokens === 'number' && typeof msg.estimated_tokens_delta === 'number') {
      return { estimatedTokens: msg.estimated_tokens };
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

  // Git branch — endpoint confirmed via recon (/v1/code/github/batch-branch-status)
  // but returned an empty branch_statuses array, so the item shape is unknown.
  // Try a few plausible key names defensively; if none match, this just never
  // fires and the bar simply omits the branch segment.
  function extractFromBranchStatus(json) {
    if (!json || !Array.isArray(json.branch_statuses) || !json.branch_statuses.length) return null;
    const item = json.branch_statuses[0];
    if (!item || typeof item !== 'object') return null;
    const branch = item.branch ?? item.branch_name ?? item.name ?? item.ref ?? item.head_ref ?? null;
    return typeof branch === 'string' && branch ? { branch } : null;
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
      } else if (url.includes('batch-branch-status')) {
        response.clone().json()
          .then((json) => {
            const fields = extractFromBranchStatus(json);
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
