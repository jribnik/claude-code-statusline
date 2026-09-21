// Classic script (not an ES module — MV3 content scripts can't declare
// "type": "module"). Assigns a single global, loaded by both the isolated
// content script and the options page so they share one schema.
//
// Owns the config schema, its defaults (which reproduce today's hardcoded
// bar exactly), and normalize(), which every read path must go through so a
// corrupt, partial, or older-version stored value can never break rendering.

(function (global) {
  const STORAGE_KEY = 'config';

  const DEFAULT_FIELDS = [
    { id: 'branch', enabled: true, bold: true },
    { id: 'ctx', enabled: true, label: 'ctx', mode: 'pct', colorize: false },
    { id: 'fiveHour', enabled: true, label: '5h', style: 'bar', showResets: true, resetsFormat: 'relative' },
    { id: 'sevenDay', enabled: true, label: '7d', style: 'text', showResets: true, resetsFormat: 'relative' },
  ];

  const DEFAULTS = {
    version: 1,
    separator: '  ·  ',
    fontSize: 12,
    thresholds: { warn: 70, crit: 90 },
    bar: { width: 10, filled: '█', empty: '░' },
    colors: { text: '#ccc', dim: '#888', ok: '#4ade80', warn: '#facc15', crit: '#f87171' },
    fields: DEFAULT_FIELDS,
  };

  const KNOWN_FIELD_IDS = DEFAULT_FIELDS.map((f) => f.id);
  const DEFAULT_FIELD_BY_ID = Object.fromEntries(DEFAULT_FIELDS.map((f) => [f.id, f]));

  function clampNum(value, min, max, fallback) {
    const n = typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
  }

  function pickEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function isHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
  }

  function pickColor(value, fallback) {
    return isHexColor(value) ? value : fallback;
  }

  function pickGlyph(value, fallback) {
    if (typeof value !== 'string' || !value.length) return fallback;
    return value[0];
  }

  function normalizeField(raw, defaults) {
    const out = {
      id: defaults.id,
      enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    };
    switch (defaults.id) {
      case 'branch':
        out.bold = typeof raw?.bold === 'boolean' ? raw.bold : defaults.bold;
        break;
      case 'ctx':
        out.label = typeof raw?.label === 'string' && raw.label ? raw.label : defaults.label;
        out.mode = pickEnum(raw?.mode, ['pct', 'tokens', 'both'], defaults.mode);
        out.colorize = typeof raw?.colorize === 'boolean' ? raw.colorize : defaults.colorize;
        break;
      case 'fiveHour':
      case 'sevenDay':
        out.label = typeof raw?.label === 'string' && raw.label ? raw.label : defaults.label;
        out.style = pickEnum(raw?.style, ['bar', 'text'], defaults.style);
        out.showResets = typeof raw?.showResets === 'boolean' ? raw.showResets : defaults.showResets;
        out.resetsFormat = pickEnum(raw?.resetsFormat, ['relative', 'clock'], defaults.resetsFormat);
        break;
    }
    return out;
  }

  // Drops unknown/duplicate field ids, keeps the stored order, and appends
  // any known field missing from the stored array at the end with its
  // default entry (so a newly added field type shows up for existing users).
  function normalizeFields(rawFields) {
    const seen = new Set();
    const result = [];
    if (Array.isArray(rawFields)) {
      for (const raw of rawFields) {
        const id = raw && raw.id;
        if (typeof id !== 'string' || !KNOWN_FIELD_IDS.includes(id) || seen.has(id)) continue;
        seen.add(id);
        result.push(normalizeField(raw, DEFAULT_FIELD_BY_ID[id]));
      }
    }
    for (const id of KNOWN_FIELD_IDS) {
      if (!seen.has(id)) result.push({ ...DEFAULT_FIELD_BY_ID[id] });
    }
    return result;
  }

  function normalize(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const warn = clampNum(s.thresholds?.warn, 0, 100, DEFAULTS.thresholds.warn);
    let crit = clampNum(s.thresholds?.crit, 0, 100, DEFAULTS.thresholds.crit);
    if (crit < warn) crit = warn;

    return {
      version: 1,
      separator: typeof s.separator === 'string' ? s.separator : DEFAULTS.separator,
      fontSize: clampNum(s.fontSize, 9, 18, DEFAULTS.fontSize),
      thresholds: { warn, crit },
      bar: {
        width: Math.round(clampNum(s.bar?.width, 4, 40, DEFAULTS.bar.width)),
        filled: pickGlyph(s.bar?.filled, DEFAULTS.bar.filled),
        empty: pickGlyph(s.bar?.empty, DEFAULTS.bar.empty),
      },
      colors: {
        text: pickColor(s.colors?.text, DEFAULTS.colors.text),
        dim: pickColor(s.colors?.dim, DEFAULTS.colors.dim),
        ok: pickColor(s.colors?.ok, DEFAULTS.colors.ok),
        warn: pickColor(s.colors?.warn, DEFAULTS.colors.warn),
        crit: pickColor(s.colors?.crit, DEFAULTS.colors.crit),
      },
      fields: normalizeFields(s.fields),
    };
  }

  global.CCSL_CONFIG = { DEFAULTS, normalize, STORAGE_KEY, KNOWN_FIELD_IDS };
})(globalThis);
