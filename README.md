# claude-code-statusline

Unofficial, best-effort Chrome extension that mirrors a real Claude Code CLI
`statusLine` script on Claude Code on the web (claude.ai/code): branch and
Pro/Max 5h/7d rate limits, anchored right under the prompt box like the
CLI's status line sits below the terminal input. Model is omitted —
claude.ai/code already shows it elsewhere in its own UI. (Context-window %
was also mirrored originally but was dropped 2026-09-21 — see Known
limitations.)
**Not affiliated with or endorsed by Anthropic.** This scrapes an unofficial,
unversioned surface (the app's own REST traffic) and can break on any
claude.ai deploy.

## Status: Phase 1 skeleton + options page + selector pack

Proves the injection/timing/architecture works and matches the target format
of a real `~/.claude/statusline.sh`, lets you customize that format via an
options page instead of it being hardcoded, and extracts REST fields via a
declarative, patchable selector pack instead of hand-rolled parsing (see
below). DOM-scraping fallback was investigated and dropped: live recon
confirmed claude.ai/code never renders branch/context/usage anywhere in the
page — the app fetches them for its own internal use only, so there's
nothing in the DOM to fall back to.

## How it works

- `src/main-world/interceptor.js` runs in the page's own JS realm
  (`"world": "MAIN"`, `document_start`) and passively wraps `window.fetch` —
  never modifying what the app itself sends or receives.
- Which URLs to tap and where fields live in their JSON is declarative, in
  `src/shared/selector-pack.js` — interceptor.js is just an interpreter of
  it. Recognized sources, found via manual recon on a live session:
  - `GET /v1/code/sessions/{session_id}` (no further path segment) — the
    session detail call the app already makes on its own. Its
    `response_shape.external_metadata` carries `current_branches` (git
    branch). This replaced an earlier attempt to read branch from
    `batch-branch-status`, which only ever returned an empty array.
  - `GET /api/organizations/{id}/usage` → `five_hour`/`seven_day`
    `{utilization, resets_at}` → the Pro/Max rate-limit bars
- **When claude.ai changes a response shape:** patch the relevant `path`
  string in `selector-pack.js`, bump `PACK_VERSION`, and add a changelog
  line at the top of the file — that's the whole fix, no need to touch
  interceptor.js. The pack distinguishes a field that's genuinely absent for
  this session (e.g. no repo connected, so no branch) from real drift (the
  field's containing object is gone or reshaped): only the latter logs a
  `console.warn` (pack version, field path, and the *shape* — key names
  only, never values — actually seen) and shows a `⚠` (in the "critical"
  color) at the end of the bar, once per distinct drift per page load.
  Toggle that indicator in Options.
- Matched fields are relayed via `window.postMessage` to
  `src/isolated/content.js`, which renders (by default)
  `branch · 5h [bar] XX% resets… · 7d XX% resets…` as a normal sibling
  inserted right after the composer's chrome box, found by walking an
  ordered list of anchor candidates (`ANCHOR_CANDIDATES` in
  `content.js`) — `'surface'` (the `bg-surface-*` chrome box), then
  `'geometry'` (a class-agnostic width-based match), then `'parent'`
  (the input's direct parent, which always succeeds if the input exists
  at all). Unlike the REST selector pack, this DOM anchor gets a real
  fallback chain rather than a single selector: a miss here costs the
  *whole bar*, not one segment, so degrading gracefully is worth the
  extra candidates. Falling back past `'surface'` logs a `console.warn`
  (`anchor pack v{N} degraded: …`, with a class/tag chain — never text
  content) and shows the same `⚠` indicator as REST drift; the composer
  input going missing entirely is console-only (no DOM to attach a `⚠`
  to), and only warns after 8 consecutive misses over at least 10s, to
  avoid false alarms during normal page load or a modal covering the
  composer. **If you see that warning:** the chain dump names the exact
  ancestor levels the code walked — patch `ANCHOR_CANDIDATES[0]`
  (`'surface'`) to match the new markup, bump `ANCHOR_PACK_VERSION`, and
  add a changelog line at the top of `content.js`.
- Rendering itself lives in `src/shared/render.js`, driven by a config
  object (schema + defaults in `src/shared/config.js`) stored in
  `chrome.storage.sync`. The options page (`src/options/`) edits that same
  config with a live preview, so the options page and the real bar can never
  drift apart.

## Install (unpacked, for development)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. Open claude.ai/code and start/resume a session — the bar appears under the
   prompt box once the session detail and usage calls resolve.
4. Right-click the extension icon → **Options** to customize which fields
   show, their order, colors, thresholds, and formatting.

## Known limitations

- Drift detection only covers the shapes the selector pack already knows
  about (see above) — it can't tell you about a field claude.ai starts
  returning that the pack has never heard of.
- **Context-window % is unavailable.** It was mirrored in earlier versions
  via `external_metadata.context_usage` on the session-detail endpoint; live
  recon on 2026-09-21 (via Chrome's remote-debugging port, both idle and
  during a real turn) confirmed that field is gone from the API entirely,
  replaced by unrelated fields (`rate_limit_info`, `model`,
  `container_cc_version`, `cross_session_inbound`). The only remaining trace
  of token counts is a `35.6k tokens` indicator the page itself briefly
  shows while a task is running — sourced from a client-side tokenizer
  running in a pool of Web Workers, computed entirely in-browser with no
  network trace to intercept, and with no denominator (no `%` available
  even if tapped). Recovering it would mean reverse-engineering that
  Worker pool's internal `postMessage` protocol — undocumented, unversioned,
  and a meaningfully bigger and more fragile undertaking than patching a
  REST path — so it was dropped rather than chased. Revisit if a REST
  source ever reappears (selector-pack.js's changelog has the full
  investigation trail).
