// Runs in the isolated world (has no access to the page's own JS realm, but
// can touch the DOM and gets extension APIs). Receives field updates from
// src/main-world/interceptor.js over postMessage and renders a status bar
// that mirrors the user's own CLI statusLine format:
//   branch · model · ctx XX% · 5h [bar] XX% resets… · 7d XX% resets…
//
// Anchoring: the chat composer input is `[data-testid="code-prompt-input"]`,
// and ~6 DOM levels up its ancestor chain sits a `bg-surface-*` box that is
// the composer's visual "chrome" (the rounded input container). The bar is
// inserted as a normal sibling right after that box, so it participates in
// the page's own layout flow instead of overlaying it.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';
  const MODEL_LABELS = {
    'claude-sonnet-5': 'Sonnet 5',
    'claude-opus-5': 'Opus 5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
  };
  const COLOR_DIM = '#888';
  const COLOR_GREEN = '#4ade80';
  const COLOR_YELLOW = '#facc15';
  const COLOR_RED = '#f87171';
  const COLOR_TEXT = '#ccc';

  const state = {
    branch: null,
    model: null,
    estimatedTokens: null,
    effectiveWindow: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    sevenDayPct: null,
    sevenDayResetsAt: null,
  };

  let host, shadow, textEl, composerInputEl;
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

  function ensureHost() {
    if (host && host.isConnected) return true;
    const found = findComposerAnchor();
    if (!found) return false;
    composerInputEl = found.input;

    host = document.createElement('div');
    host.id = 'ccsl-host';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .bar {
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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
    textEl = document.createElement('div');
    textEl.className = 'bar';
    shadow.append(style, textEl);

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

  function colorFor(pct) {
    if (typeof pct !== 'number') return COLOR_DIM;
    if (pct >= 90) return COLOR_RED;
    if (pct >= 70) return COLOR_YELLOW;
    return COLOR_GREEN;
  }

  function progressBar(pct) {
    if (typeof pct !== 'number') return '──────────';
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  function resetsIn(isoString) {
    if (!isoString) return '';
    const diffMs = new Date(isoString).getTime() - Date.now();
    if (Number.isNaN(diffMs)) return '';
    if (diffMs < 0) return 'resetting';
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec >= 86400) {
      const d = Math.floor(diffSec / 86400);
      const h = Math.floor((diffSec % 86400) / 3600);
      return `resets ${d}d ${h}h`;
    }
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    return h > 0 ? `resets ${h}h ${m}m` : `resets ${m}m`;
  }

  function span(text, { color, bold } = {}) {
    const el = document.createElement(bold ? 'b' : 'span');
    el.textContent = text;
    if (color) el.style.color = color;
    return el;
  }

  function dot() {
    return span('  ·  ', { color: COLOR_DIM });
  }

  function render() {
    if (!ensureHost()) return;
    alignToComposerText();

    const nodes = [];

    if (state.branch) {
      nodes.push(span(state.branch, { bold: true, color: COLOR_TEXT }));
      nodes.push(dot());
    }

    const modelLabel = state.model ? (MODEL_LABELS[state.model] || state.model) : null;
    if (modelLabel) nodes.push(span(modelLabel, { bold: true, color: COLOR_TEXT }));

    if (typeof state.estimatedTokens === 'number' && typeof state.effectiveWindow === 'number' && state.effectiveWindow > 0) {
      const pct = Math.min(100, Math.round((state.estimatedTokens / state.effectiveWindow) * 100));
      nodes.push(dot());
      nodes.push(span(`ctx ${pct}%`, { color: COLOR_TEXT }));
    }

    if (typeof state.fiveHourPct === 'number') {
      nodes.push(dot());
      nodes.push(span('5h ', { color: COLOR_TEXT }));
      const c = colorFor(state.fiveHourPct);
      nodes.push(span(`${progressBar(state.fiveHourPct)} ${state.fiveHourPct}%`, { color: c }));
      const resets = resetsIn(state.fiveHourResetsAt);
      if (resets) nodes.push(span(` ${resets}`, { color: COLOR_DIM }));
    }

    if (typeof state.sevenDayPct === 'number') {
      nodes.push(dot());
      nodes.push(span('7d ', { color: COLOR_TEXT }));
      const c = colorFor(state.sevenDayPct);
      nodes.push(span(`${state.sevenDayPct}%`, { color: c }));
      const resets = resetsIn(state.sevenDayResetsAt);
      if (resets) nodes.push(span(` ${resets}`, { color: COLOR_DIM }));
    }

    if (!nodes.length) nodes.push(span('(waiting for session data…)', { color: COLOR_DIM }));

    textEl.replaceChildren(...nodes);
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
