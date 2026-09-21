// Runs in the isolated world (has no access to the page's own JS realm, but
// can touch the DOM and gets extension APIs). Receives field updates from
// src/main-world/interceptor.js over postMessage and renders a status bar
// that mirrors the user's own CLI statusLine format, shaped by the user's
// options (see src/options/); defaults reproduce:
//   branch · ctx XX% · 5h [bar] XX% resets… · 7d XX% resets…
// (model is omitted — claude.ai/code already shows it in its own UI)
//
// Rendering itself lives in src/shared/render.js (CCSL_RENDER), shared with
// the options page's live preview so the two can never drift apart. This
// file owns the postMessage bridge, DOM anchoring, and config storage.
//
// Anchoring: the chat composer input is `[data-testid="code-prompt-input"]`,
// and ~6 DOM levels up its ancestor chain sits a `bg-surface-*` box that is
// the composer's visual "chrome" (the rounded input container). The bar is
// inserted as a normal sibling right after that box, so it participates in
// the page's own layout flow instead of overlaying it.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';

  const state = {
    branch: null,
    ctxUsedTokens: null,
    ctxMaxTokens: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    sevenDayPct: null,
    sevenDayResetsAt: null,
  };

  let config = CCSL_CONFIG.DEFAULTS;

  let host, shadow, styleEl, textEl, composerInputEl;
  let tickTimer = null;

  function findComposerAnchor() {
    const input = document.querySelector('[data-testid="code-prompt-input"]');
    if (!input) return null;
    let node = input.parentElement;
    for (let i = 0; i < 10 && node; i++) {
      if (/\bbg-surface-\d/.test(node.className || '')) return { anchor: node, input };
      node = node.parentElement;
    }
    return null;
  }

  function applyStyle() {
    if (!styleEl) return;
    styleEl.textContent = `
      .bar {
        font: ${config.fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        margin-top: 8px;
        padding: 4px 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        user-select: text;
        box-sizing: border-box;
      }
      .bar b { font-weight: 600; }
    `;
  }

  function ensureHost() {
    if (host && host.isConnected) return true;
    const found = findComposerAnchor();
    if (!found) return false;
    composerInputEl = found.input;

    host = document.createElement('div');
    host.id = 'ccsl-host';
    shadow = host.attachShadow({ mode: 'closed' });

    styleEl = document.createElement('style');
    textEl = document.createElement('div');
    textEl.className = 'bar';
    shadow.append(styleEl, textEl);
    applyStyle();

    found.anchor.insertAdjacentElement('afterend', host);

    if (!tickTimer) tickTimer = setInterval(render, 30000);
    return true;
  }

  function alignToComposerText() {
    if (!composerInputEl || !host) return;
    const inputRect = composerInputEl.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const offset = Math.max(0, Math.round(inputRect.left - hostRect.left));
    textEl.style.paddingLeft = `${offset}px`;
  }

  function render() {
    if (!ensureHost()) return;
    alignToComposerText();
    textEl.replaceChildren(...CCSL_RENDER.buildNodes(state, config, Date.now()));
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

  chrome.storage.sync.get({ [CCSL_CONFIG.STORAGE_KEY]: null }, (result) => {
    config = CCSL_CONFIG.normalize(result[CCSL_CONFIG.STORAGE_KEY]);
    applyStyle();
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[CCSL_CONFIG.STORAGE_KEY]) return;
    config = CCSL_CONFIG.normalize(changes[CCSL_CONFIG.STORAGE_KEY].newValue);
    applyStyle();
    render();
  });

  // The composer (and its ancestors) can be torn down and rebuilt by the
  // app's SPA router; re-attach whenever that happens.
  new MutationObserver(() => {
    if (!host || !host.isConnected) render();
  }).observe(document.documentElement, { childList: true, subtree: true });

  render();
})();
