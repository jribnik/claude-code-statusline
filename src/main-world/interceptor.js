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

    // CLI-protocol "system" init message: model, cwd, permission mode, etc.
    if (msg.type === 'system' && msg.subtype === 'init') {
      return {
        model: msg.model,
        cwd: msg.cwd,
        permissionMode: msg.permissionMode,
        claudeCodeVersion: msg.claude_code_version,
      };
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

    // Session status / subtype changes (idle, working, etc. — subtype names
    // not yet fully enumerated; relayed as-is for the renderer to display).
    if (msg.type === 'system' && msg.subtype && msg.subtype !== 'init' && msg.subtype !== 'commands_changed') {
      return { sessionSubtype: msg.subtype };
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
