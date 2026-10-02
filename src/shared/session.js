// Pure helpers for session-scoped state, shared with tests (tests/pure.test.mjs).
// Classic script that assigns a global, like the other files in src/shared/.
(function (global) {
  // "/code/session_abc" or "/code/session_abc/anything" -> "session_abc"; anything else -> null.
  // Compares whole path segments: a substring match would let session_ab "match" session_abc.
  function sessionIdFromPath(pathname) {
    const parts = String(pathname || '').split('/');
    if (parts[1] !== 'code' || !parts[2]) return null;
    return parts[2];
  }

  // Branch per session id. The app can fetch a session's detail before the URL changes (or
  // prefetch sessions we are not on), so every response is stored under its own session id and
  // the bar renders whichever entry belongs to the session in the URL now. Bounded so a long
  // browsing session can't grow it without limit. LRU: get() refreshes recency too, so the
  // session being viewed (read on every render) isn't evicted by a burst of prefetches.
  function createBranchStore(max = 100) {
    const map = new Map();
    return {
      set(sessionId, branch) {
        if (!sessionId) return;
        map.delete(sessionId); // re-insert to mark most recent
        map.set(sessionId, branch);
        if (map.size > max) map.delete(map.keys().next().value);
      },
      get(sessionId) {
        if (!sessionId || !map.has(sessionId)) return null;
        const branch = map.get(sessionId);
        map.delete(sessionId); // re-insert to mark most recent
        map.set(sessionId, branch);
        return branch;
      },
    };
  }

  global.CCSL_SESSION = { sessionIdFromPath, createBranchStore };
})(globalThis);
