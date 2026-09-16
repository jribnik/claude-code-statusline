# claude-code-statusline

Unofficial, best-effort Chrome extension that mirrors a real Claude Code CLI
`statusLine` script on Claude Code on the web (claude.ai/code): branch, model,
context usage, and Pro/Max 5h/7d rate limits, anchored right under the prompt
box like the CLI's status line sits below the terminal input. **Not affiliated
with or endorsed by Anthropic.** This scrapes an unofficial, unversioned
surface (the app's own WebSocket + REST traffic) and can break on any
claude.ai deploy.

## Status: Phase 1 skeleton

Proves the injection/timing/architecture works and matches the target format
of a real `~/.claude/statusline.sh`. Not yet built: options page (the format
is hardcoded to one particular script's output), DOM-scraping fallback,
selector-pack resilience layer. See the full design writeup for the target
architecture (ask in the originating conversation if you don't have it).

## How it works

- `src/main-world/interceptor.js` runs in the page's own JS realm
  (`"world": "MAIN"`, `document_start`) and passively wraps `window.WebSocket`
  and `window.fetch` — never modifying what the app itself sends or receives.
- Recognized sources, all found via manual recon on a live session:
  - WebSocket `{type: "system", subtype: "init", model, ...}` → model name
  - WebSocket `{type: "autocompact_state", value: {effective_window, ...}}`
    plus `{estimated_tokens, ...}` → context-window usage %
  - `GET /api/organizations/{id}/usage` → `five_hour`/`seven_day`
    `{utilization, resets_at}` → the Pro/Max rate-limit bars
  - `GET .../batch-branch-status` → git branch (endpoint confirmed, but the
    response was `{branch_statuses: []}` during recon, so the populated item
    shape is unverified — extraction is defensive and just won't fire until
    we see a real example)
- Matched fields are relayed via `window.postMessage` to
  `src/isolated/content.js`, which renders
  `branch · model · ctx XX% · 5h [bar] XX% resets… · 7d XX% resets…` as a
  normal sibling inserted right after the composer's chrome box (found via
  `[data-testid="code-prompt-input"]`), inside a closed shadow root.

## Install (unpacked, for development)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. Open claude.ai/code and start/resume a session — the bar appears under the
   prompt box once the session's `system`/`init` message arrives.

## Known limitations

- Git branch isn't shown yet — see above.
- No fallback if claude.ai changes its WebSocket/REST shapes; fields that stop
  matching just silently disappear from the bar rather than erroring.
- No user configuration — the format mirrors one specific `statusline.sh`,
  hardcoded in `src/isolated/content.js`.
