// Runs in the isolated world (has no access to the page's own JS realm, but
// can touch the DOM and gets extension APIs). Receives field updates from
// src/main-world/interceptor.js over postMessage and renders a small status
// bar in a closed shadow root, so nothing here can collide with or be read
// back by the page's own styles/scripts.
//
// Anchoring: confirmed via manual recon that the chat composer input is
// `[data-testid="code-prompt-input"]`, and ~6 DOM levels up its ancestor
// chain sits a `bg-surface-*` box that is the composer's visual "chrome"
// (the rounded input container). The bar is inserted as a normal sibling
// right after that box, so it participates in the page's own layout flow
// instead of overlaying it — no fixed positioning or padding hacks needed.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';
  const MODEL_LABELS = {
    'claude-sonnet-5': 'Sonnet 5',
    'claude-opus-5': 'Opus 5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
  };

  const state = {
    model: null,
    cwd: null,
    permissionMode: null,
    estimatedTokens: null,
    effectiveWindow: null,
    autocompactThreshold: null,
    sessionSubtype: null,
  };

  let host, shadow, textEl;

  function findComposerAnchor() {
    const input = document.querySelector('[data-testid="code-prompt-input"]');
    if (!input) return null;
    let node = input.parentElement;
    for (let i = 0; i < 10 && node; i++) {
      if (/\bbg-surface-\d/.test(node.className || '')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function ensureHost() {
    if (host && host.isConnected) return true;
    const anchor = findComposerAnchor();
    if (!anchor) return false;

    host = document.createElement('div');
    host.id = 'ccsl-host';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .bar {
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #999;
        padding: 4px 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        user-select: text;
        box-sizing: border-box;
      }
    `;
    textEl = document.createElement('div');
    textEl.className = 'bar';
    shadow.append(style, textEl);

    anchor.insertAdjacentElement('afterend', host);
    return true;
  }

  function shortCwd(cwd) {
    if (!cwd) return null;
    const parts = cwd.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }

  function render() {
    if (!ensureHost()) return;
    const segments = [];

    const modelLabel = state.model ? (MODEL_LABELS[state.model] || state.model) : null;
    if (modelLabel) segments.push(modelLabel);

    const cwd = shortCwd(state.cwd);
    if (cwd) segments.push(cwd);

    if (typeof state.estimatedTokens === 'number' && typeof state.effectiveWindow === 'number' && state.effectiveWindow > 0) {
      const pct = Math.min(100, Math.round((state.estimatedTokens / state.effectiveWindow) * 100));
      segments.push(`ctx ${pct}%`);
    } else if (typeof state.estimatedTokens === 'number') {
      segments.push(`~${state.estimatedTokens.toLocaleString()} tok`);
    }

    if (state.sessionSubtype) segments.push(state.sessionSubtype);
    if (state.permissionMode) segments.push(`mode:${state.permissionMode}`);

    textEl.textContent = segments.length ? segments.join('  ·  ') : '(waiting for session data…)';
  }

  function onMessage(event) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.__ccsl !== 1 || data.type !== BRIDGE_TYPE) return;
    if (!data.fields || typeof data.fields !== 'object') return;

    for (const [key, value] of Object.entries(data.fields)) {
      if (key in state) state[key] = value;
    }
    render();
  }

  window.addEventListener('message', onMessage);

  // The composer (and its ancestors) can be torn down and rebuilt by the
  // app's SPA router; re-attach whenever that happens.
  new MutationObserver(() => {
    if (!host || !host.isConnected) render();
  }).observe(document.documentElement, { childList: true, subtree: true });

  render();
})();
