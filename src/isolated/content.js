// Runs in the isolated world (has no access to the page's own JS realm, but
// can touch the DOM and gets extension APIs). Receives field updates from
// src/main-world/interceptor.js over postMessage and renders a status bar
// that mirrors the user's own CLI statusLine format, shaped by the user's
// options (see src/options/); defaults reproduce:
//   branch · 5h [bar] XX% resets… · 7d XX% resets…
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
// the page's own layout flow instead of overlaying it. Unlike the REST
// fields (see src/shared/selector-pack.js), this is a live DOM structure
// with no API contract, so it gets its own small ordered fallback chain
// instead of a single selector — see ANCHOR_CANDIDATES below.
//
// ANCHOR CHANGELOG (newest first)
//   v1  2026-09-21  initial: 'surface' (bg-surface-* class walk), 'geometry'
//                   (class-agnostic width-based match), 'parent' (always
//                   succeeds if the input exists) as a last-resort fallback.

(() => {
  const BRIDGE_TYPE = '__ccsl_field_update';
  const DRIFT_TYPE = '__ccsl_drift';
  const ANCHOR_PACK_VERSION = 1;

  const state = {
    branch: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    sevenDayPct: null,
    sevenDayResetsAt: null,
    restDrift: null,
    domDrift: null,
    drift: null,
  };

  let config = CCSL_CONFIG.DEFAULTS;

  let host, shadow, styleEl, textEl, composerInputEl;
  let tickTimer = null;
  let lastPath = location.pathname;
  let missStreak = 0;
  let missStreakStartedAt = 0;
  const warnedAnchor = new Set();

  // Tried in order; first candidate that resolves an element wins. A miss
  // costs the whole bar (unlike a missed REST field, which costs one
  // segment), so — unlike selector-pack.js's deliberate no-fallback-chains
  // stance — a short chain here converts a likely total failure into a
  // degraded-but-visible one.
  const ANCHOR_CANDIDATES = [
    {
      id: 'surface',
      find(input) {
        let node = input.parentElement;
        for (let i = 0; i < 10 && node; i++) {
          if (/\bbg-surface-\d/.test(node.className || '')) return node;
          node = node.parentElement;
        }
        return null;
      },
    },
    {
      id: 'geometry',
      find(input) {
        const inputWidth = input.getBoundingClientRect().width;
        if (!inputWidth) return null;
        let node = input.parentElement;
        let candidate = null;
        for (let i = 0; i < 10 && node; i++) {
          const w = node.getBoundingClientRect().width;
          if (w > 0 && w <= inputWidth * 1.4) candidate = node;
          node = node.parentElement;
        }
        return candidate;
      },
    },
    {
      id: 'parent',
      find(input) {
        return input.parentElement;
      },
    },
  ];

  function findComposerAnchor() {
    const input = document.querySelector('[data-testid="code-prompt-input"]');
    if (!input) return null;
    for (let index = 0; index < ANCHOR_CANDIDATES.length; index++) {
      const anchor = ANCHOR_CANDIDATES[index].find(input);
      if (anchor) return { anchor, input, candidateId: ANCHOR_CANDIDATES[index].id, index };
    }
    return null;
  }

  // DOM analogue of selector-pack.js's shapeOf(): structure only, never
  // text content (the redaction boundary — class names carry no user data,
  // conversation text does).
  function describeChain(input, depth) {
    const parts = [];
    let node = input;
    for (let i = 0; i < depth && node; i++) {
      const tag = node.tagName ? node.tagName.toLowerCase() : '?';
      const id = node.id ? `#${node.id}` : '';
      const testid = node.getAttribute && node.getAttribute('data-testid');
      const testidPart = testid ? `[data-testid=${testid}]` : '';
      const classes = typeof node.className === 'string'
        ? node.className.split(/\s+/).filter(Boolean).slice(0, 6).join('.')
        : '';
      parts.push(`${tag}${id}${testidPart}${classes ? `.${classes}` : ''}`);
      node = node.parentElement;
    }
    return parts.join(' < ');
  }

  function describeTestIds() {
    const ids = new Set();
    document.querySelectorAll('[data-testid]').forEach((el) => ids.add(el.getAttribute('data-testid')));
    return [...ids].sort().slice(0, 30).join(', ');
  }

  function syncDrift() {
    const items = [...(state.restDrift?.items || []), ...(state.domDrift?.items || [])];
    const packVersion = state.restDrift?.packVersion ?? state.domDrift?.packVersion ?? null;
    state.drift = items.length ? { packVersion, items } : null;
  }

  function reportAnchorDrift(kind, detail) {
    const sig = `${ANCHOR_PACK_VERSION}|${kind}`;
    if (warnedAnchor.has(sig)) return;
    warnedAnchor.add(sig);
    console.warn(`[claude-code-statusline] anchor pack v${ANCHOR_PACK_VERSION} ${kind}: ${detail}`);
    state.domDrift = { packVersion: ANCHOR_PACK_VERSION, items: [{ endpoint: 'dom', key: 'composerAnchor' }] };
    syncDrift();
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

    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      missStreak = 0;
    }

    const found = findComposerAnchor();
    if (!found) {
      if (missStreak === 0) missStreakStartedAt = Date.now();
      missStreak++;
      if (missStreak >= 8 && Date.now() - missStreakStartedAt >= 10000) {
        reportAnchorDrift('missing', `composer input not found; visible data-testid values: ${describeTestIds()}`);
      }
      return false;
    }
    missStreak = 0;

    if (found.index > 0) {
      reportAnchorDrift(
        'degraded',
        `using fallback anchor '${found.candidateId}' (index ${found.index}); chain: ${describeChain(found.input, 6)}`
      );
    }

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
    if (!data || data.__ccsl !== 1) return;

    if (data.type === BRIDGE_TYPE && data.fields && typeof data.fields === 'object') {
      for (const [key, value] of Object.entries(data.fields)) {
        if (key in state) state[key] = value;
      }
      render();
    } else if (data.type === DRIFT_TYPE && Array.isArray(data.items)) {
      state.restDrift = { packVersion: data.packVersion, items: data.items };
      syncDrift();
      render();
    }
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
