# claude-code-statusline

Unofficial, best-effort Chrome extension that adds a CLI-style status bar to
Claude Code on the web (claude.ai/code) — model, working directory, token/context
usage, session state. **Not affiliated with or endorsed by Anthropic.** This
scrapes an unofficial, unversioned surface (the app's own WebSocket traffic) and
can break on any claude.ai deploy.

## Status: Phase 1 skeleton

Proves the injection/timing/architecture works and renders real fields. Not yet
built: options page, DOM-scraping fallback, git branch, cost, selector-pack
resilience layer. See the full design writeup for the target architecture (ask
in the originating conversation if you don't have it).

## How it works

- `src/main-world/interceptor.js` runs in the page's own JS realm
  (`"world": "MAIN"`, `document_start`) and passively wraps `window.WebSocket`
  to read the session socket's messages — never modifying what the app itself
  receives.
- It recognizes three message shapes found via manual recon on a live session:
  - `{type: "system", subtype: "init", model, cwd, permissionMode, ...}`
  - `{type: "autocompact_state", value: {effective_window, threshold, ...}}`
  - `{estimated_tokens, estimated_tokens_delta, ...}` (running token count)
- Matched fields are relayed via `window.postMessage` to
  `src/isolated/content.js`, which renders them in a fixed bar at the bottom of
  the viewport, inside a closed shadow root so it can't collide with page CSS.

## Install (unpacked, for development)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this repo's folder.
3. Open claude.ai/code and start/resume a session — the bar appears at the
   bottom once the session's `system`/`init` message arrives.

## Known limitations

- Git branch/dirty state is not shown yet — recon found it comes from a
  separate REST call (`/v1/code/github/batch-branch-status`), not the socket.
- No fallback if claude.ai changes its WebSocket message shapes; the bar will
  silently show `(waiting for session data…)`.
- No user configuration yet — fields and format are hardcoded in
  `src/isolated/content.js`.
