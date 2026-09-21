// Classic script (see config.js for why), loaded in the MAIN world just
// before src/main-world/interceptor.js. Declares WHICH urls to tap and
// WHERE fields live in their JSON, so interceptor.js is a thin interpreter
// rather than hand-rolled optional-chaining. When claude.ai changes a
// response shape, patch a `path` string here — nothing else should need to
// change. Bump PACK_VERSION and add a changelog line on every patch; the
// version exists only as a debugging trail (it appears in every drift
// warning), it does not drive any fallback-path logic — see README.
//
// PACK CHANGELOG (newest first)
//   v2  2026-09-21  dropped sessionDetail.ctxUsedTokens/ctxMaxTokens: live
//                   recon confirmed external_metadata.context_usage is gone
//                   from the API entirely (replaced by unrelated fields:
//                   rate_limit_info, model, container_cc_version,
//                   cross_session_inbound). Context-window % now appears to
//                   be computed client-side by a local tokenizer Worker pool
//                   with no network trace — not recoverable via this pack.
//                   Re-add if a REST source resurfaces.
//   v1  2026-09-21  initial: sessionDetail + usage, as confirmed by recon

(function (global) {
  const PACK_VERSION = 2;

  // path grammar: dot-separated object keys; '*' (last segment only) means
  // "try every own value at this level" — first candidate passing `type`
  // wins. `anchor` is the object that must exist for a miss to be silent
  // ("legitimately absent for this session") rather than drift; it defaults
  // to `path` minus its last segment.
  const ENDPOINTS = [
    {
      id: 'usage',
      match: /\/organizations\/[^/]+\/usage(\?|$)/,
      root: null,
      fields: [
        { key: 'fiveHourPct', path: 'five_hour.utilization', type: 'number', presence: 'required' },
        {
          key: 'fiveHourResetsAt',
          path: 'five_hour.resets_at',
          type: 'string',
          presence: 'optional',
          anchor: 'five_hour',
          requires: 'fiveHourPct',
          emitNull: true,
        },
        { key: 'sevenDayPct', path: 'seven_day.utilization', type: 'number', presence: 'required' },
        {
          key: 'sevenDayResetsAt',
          path: 'seven_day.resets_at',
          type: 'string',
          presence: 'optional',
          anchor: 'seven_day',
          requires: 'sevenDayPct',
          emitNull: true,
        },
      ],
    },
    {
      id: 'sessionDetail',
      match: /\/v1\/code\/sessions\/(session_[^/?]+)(?:\?|$)/,
      root: 'response_shape',
      fields: [
        {
          key: 'branch',
          path: 'external_metadata.current_branches.*',
          type: 'nonEmptyString',
          presence: 'optional',
          anchor: 'external_metadata',
        },
      ],
    },
  ];

  const VALIDATORS = {
    number: (v, min) => typeof v === 'number' && !Number.isNaN(v) && (min === undefined || v >= min),
    string: (v) => typeof v === 'string',
    nonEmptyString: (v) => typeof v === 'string' && v.length > 0,
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  };

  // Redaction boundary for drift logging: shapes only, never values.
  function shapeOf(node) {
    if (node === undefined) return 'undefined';
    if (node === null) return 'null';
    if (Array.isArray(node)) return `array[${node.length}]`;
    if (typeof node === 'object') {
      const keys = Object.keys(node).sort();
      const shown = keys.slice(0, 20).map((k) => (k.length > 40 ? `${k.slice(0, 40)}…` : k));
      const extra = keys.length > 20 ? ` +${keys.length - 20} more` : '';
      return `{${shown.join(', ')}${extra}}`;
    }
    return typeof node;
  }

  function resolveField(base, path) {
    const segments = path.split('.');
    let cur = base;
    for (const seg of segments) {
      if (seg === '*') {
        if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
          return { hit: true, candidates: Object.values(cur) };
        }
        return { hit: false, candidates: [] };
      }
      if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
        cur = cur[seg];
      } else {
        return { hit: false, candidates: [] };
      }
    }
    return { hit: true, candidates: [cur] };
  }

  function defaultAnchor(path) {
    const segments = path.split('.');
    segments.pop();
    return segments.join('.') || null;
  }

  function resolveAnchor(base, anchorPath) {
    if (!anchorPath) return base;
    let cur = base;
    for (const seg of anchorPath.split('.')) {
      if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
        cur = cur[seg];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  function matchEndpoint(url) {
    if (!url) return null;
    return ENDPOINTS.find((ep) => ep.match.test(url)) || null;
  }

  function extract(endpoint, json) {
    let base = json;
    if (endpoint.root) {
      const root = resolveAnchor(json, endpoint.root);
      if (!VALIDATORS.object(root)) {
        return {
          fields: null,
          drift: [{ scope: 'endpoint', key: null, path: endpoint.root, anchor: null, sawAt: '(root)', saw: shapeOf(json) }],
        };
      }
      base = root;
    }

    const fields = {};
    const drift = [];
    const hitKeys = new Set();

    for (const field of endpoint.fields) {
      const resolved = resolveField(base, field.path);
      const validator = VALIDATORS[field.type];
      const value = resolved.hit ? resolved.candidates.find((c) => validator(c, field.min)) : undefined;

      if (value !== undefined) {
        fields[field.key] = value;
        hitKeys.add(field.key);
        continue;
      }

      const anchorPath = field.anchor || defaultAnchor(field.path);
      const anchorValue = resolveAnchor(base, anchorPath);
      const anchorOk = VALIDATORS.object(anchorValue);
      if (!anchorOk || field.presence === 'required') {
        drift.push({
          scope: 'field',
          key: field.key,
          path: field.path,
          anchor: anchorPath,
          sawAt: anchorPath || '(root)',
          saw: shapeOf(anchorValue),
        });
      }
      // else: anchor is healthy, this field is just legitimately absent
      // for this session (e.g. no repo connected) — not drift, stay silent.
    }

    for (const field of endpoint.fields) {
      if (!field.requires) continue;
      if (!hitKeys.has(field.requires)) {
        delete fields[field.key];
      } else if (!(field.key in fields) && field.emitNull) {
        fields[field.key] = null;
      }
    }

    return { fields: Object.keys(fields).length ? fields : null, drift };
  }

  global.CCSL_PACK = { version: PACK_VERSION, matchEndpoint, extract };
})(globalThis);
