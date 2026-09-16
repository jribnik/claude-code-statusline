// Runs in the isolated world (has no access to the page's own JS realm, but
// can touch the DOM and gets extension APIs). Receives field updates from
// src/main-world/interceptor.js over postMessage and renders a small fixed
// status bar in a closed shadow root, so nothing here can collide with or be
// read back by the page's own styles/scripts.

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

  // Reserves room at the bottom of the page for the bar instead of overlapping
  // page content — the page's own bottom padding grows/shrinks to match the
  // bar's real rendered height.
  const reserveSpace = new ResizeObserver((entries) => {
    const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect?.height;
    if (typeof height === 'number') {
      document.documentElement.style.setProperty('--ccsl-bar-height', `${Math.ceil(height)}px`);
      document.documentElement.style.paddingBottom = `${Math.ceil(height)}px`;
    }
  });

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'ccsl-host';
    host.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .bar {
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #e5e5e5;
        background: #141414;
        border-top: 1px solid #333;
        padding: 4px 10px;
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

    (document.documentElement || document.body).appendChild(host);
    reserveSpace.disconnect();
    reserveSpace.observe(host);
  }

  function shortCwd(cwd) {
    if (!cwd) return null;
    const parts = cwd.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
  }

  function render() {
    ensureHost();
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

  // Re-attach the bar if the app's SPA router replaces document content.
  new MutationObserver(() => ensureHost()).observe(document.documentElement, { childList: true });

  ensureHost();
  render();
})();
