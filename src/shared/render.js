// Classic script (see config.js for why). Pure DOM-node construction: takes
// a field state object and a normalized config and returns the array of
// nodes to render, with no knowledge of storage, anchoring, or timers. Used
// by both the isolated content script (real state) and the options page
// (sample state, for the live preview) so they can never drift apart.

(function (global) {
  function colorFor(pct, config) {
    if (typeof pct !== 'number') return config.colors.dim;
    if (pct >= config.thresholds.crit) return config.colors.crit;
    if (pct >= config.thresholds.warn) return config.colors.warn;
    return config.colors.ok;
  }

  function progressBar(pct, config) {
    const width = config.bar.width;
    if (typeof pct !== 'number') return config.bar.empty.repeat(width);
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
    return config.bar.filled.repeat(filled) + config.bar.empty.repeat(width - filled);
  }

  function resetsIn(isoString, format, now) {
    if (!isoString) return '';
    const nowMs = typeof now === 'number' ? now : Date.now();
    const diffMs = new Date(isoString).getTime() - nowMs;
    if (Number.isNaN(diffMs)) return '';
    if (diffMs < 0) return 'resetting';
    if (format === 'clock') {
      return `resets ${new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
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

  function separatorNode(config) {
    return span(config.separator, { color: config.colors.dim });
  }

  function fmtTokens(n) {
    if (typeof n !== 'number') return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return `${n}`;
  }

  function buildBranchNode(field, state, config) {
    if (!state.branch) return [];
    return [span(state.branch, { bold: field.bold, color: config.colors.text })];
  }

  function buildCtxNode(field, state, config) {
    const used = state.ctxUsedTokens;
    const max = state.ctxMaxTokens;
    if (typeof used !== 'number' || typeof max !== 'number' || max <= 0) return [];
    const pct = Math.min(100, Math.round((used / max) * 100));
    let text;
    if (field.mode === 'tokens') text = `${field.label} ${fmtTokens(used)}/${fmtTokens(max)}`;
    else if (field.mode === 'both') text = `${field.label} ${pct}% (${fmtTokens(used)}/${fmtTokens(max)})`;
    else text = `${field.label} ${pct}%`;
    const color = field.colorize ? colorFor(pct, config) : config.colors.text;
    return [span(text, { color })];
  }

  function buildRateLimitNode(field, pct, resetsAt, config, now) {
    if (typeof pct !== 'number') return [];
    const nodes = [span(`${field.label} `, { color: config.colors.text })];
    const color = colorFor(pct, config);
    if (field.style === 'bar') {
      nodes.push(span(`${progressBar(pct, config)} ${pct}%`, { color }));
    } else {
      nodes.push(span(`${pct}%`, { color }));
    }
    if (field.showResets) {
      const resets = resetsIn(resetsAt, field.resetsFormat, now);
      if (resets) nodes.push(span(` ${resets}`, { color: config.colors.dim }));
    }
    return nodes;
  }

  function buildNodes(state, config, now) {
    const nodes = [];
    for (const field of config.fields) {
      if (!field.enabled) continue;
      let segmentNodes;
      switch (field.id) {
        case 'branch':
          segmentNodes = buildBranchNode(field, state, config);
          break;
        case 'ctx':
          segmentNodes = buildCtxNode(field, state, config);
          break;
        case 'fiveHour':
          segmentNodes = buildRateLimitNode(field, state.fiveHourPct, state.fiveHourResetsAt, config, now);
          break;
        case 'sevenDay':
          segmentNodes = buildRateLimitNode(field, state.sevenDayPct, state.sevenDayResetsAt, config, now);
          break;
        default:
          segmentNodes = [];
      }
      if (!segmentNodes.length) continue;
      if (nodes.length) nodes.push(separatorNode(config));
      nodes.push(...segmentNodes);
    }
    if (!nodes.length) nodes.push(span('(waiting for session data…)', { color: config.colors.dim }));
    return nodes;
  }

  global.CCSL_RENDER = { buildNodes, colorFor, progressBar, resetsIn, span };
})(globalThis);
