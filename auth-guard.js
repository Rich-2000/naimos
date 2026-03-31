(function () {
  'use strict';
 
  var PUBLIC_PATHS  = ['/login.html', '/reset-password.html'];
  var LOGIN_URL     = '/login.html';
  var ME_ENDPOINT   = '/api/auth/me';
  var REDIRECT_FLAG = 'naimos_guard_redirect';
  var currentPath   = window.location.pathname;
 
  // Do not guard public pages
  if (PUBLIC_PATHS.some(function (p) {
    return currentPath === p || currentPath.endsWith(p);
  })) {
    return;
  }
 
  // ── FIX 1: Anti-redirect-loop sentinel ────────────────────────────────
  // If we redirected in the last 3 seconds, don't redirect again.
  // This prevents an infinite loop if the login page itself redirects back.
  try {
    var lastRedirect = parseInt(sessionStorage.getItem(REDIRECT_FLAG) || '0', 10);
    if (Date.now() - lastRedirect < 3000) {
      // We are in a redirect loop — stop and show an error instead of looping.
      console.error('[NAIMOS Guard] Redirect loop detected. Clearing tokens and halting.');
      clearAllTokens();
      sessionStorage.removeItem(REDIRECT_FLAG);
      return; // Stay on current page; login.html will show normally
    }
  } catch (e) { /* storage blocked */ }
 
  // ── FIX 3: Multi-store token reader ───────────────────────────────────
  function readToken() {
    var token = null;
    try { token = sessionStorage.getItem('naimos_token'); } catch (e) {}
    if (!token) {
      try { token = localStorage.getItem('naimos_token'); } catch (e) {}
    }
    if (!token) {
      // Cookie fallback for ITP-affected browsers
      var match = document.cookie.match(/(?:^|;\s*)naimos_token_fb=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }
    return token;
  }
 
  function clearAllTokens() {
    try { sessionStorage.removeItem('naimos_token'); } catch (e) {}
    try { localStorage.removeItem('naimos_token'); } catch (e) {}
    // Clear cookie fallback
    document.cookie = 'naimos_token_fb=; path=/; max-age=0; SameSite=Strict';
    window.NAIMOS_TOKEN = null;
  }
 
  function redirectToLogin() {
    try { sessionStorage.setItem(REDIRECT_FLAG, String(Date.now())); } catch (e) {}
    window.location.replace(LOGIN_URL);
  }
 
  // ── FIX 2: Graceful JWT decode with server fallback ───────────────────
  function decodeJWTPayload(token) {
    try {
      var parts = token.split('.');
      if (parts.length !== 3) return null;
      // Pad base64url correctly
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      return JSON.parse(atob(b64));
    } catch (e) {
      return null; // Malformed — don't redirect yet, try server
    }
  }
 
  // ── FIX 4: Token expiry with 60-second grace period ───────────────────
  function isTokenExpired(payload) {
    if (!payload || !payload.exp) return false; // No exp claim — trust server
    var GRACE_SECONDS = 60;
    return (Date.now() / 1000) > (payload.exp - GRACE_SECONDS);
  }
 
  // ── Main guard logic ──────────────────────────────────────────────────
  var token = readToken();
 
  if (!token) {
    redirectToLogin();
    return;
  }
 
  var payload = decodeJWTPayload(token);
 
  if (payload && isTokenExpired(payload)) {
    // Token is definitively expired — clear and redirect
    clearAllTokens();
    redirectToLogin();
    return;
  }
 
  if (!payload) {
    // Malformed JWT — validate with server before redirecting
    // (FIX 2: this handles the case where the token is valid server-side
    //  but base64 decode fails due to browser quirks or non-standard encoding)
    fetch(ME_ENDPOINT, {
      headers: { 'Authorization': 'Bearer ' + token },
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) {
        clearAllTokens();
        redirectToLogin();
      }
      // If ok, stay on page — token is valid despite decode failure
    }).catch(function () {
      // Network error — stay on page optimistically rather than looping
      console.warn('[NAIMOS Guard] Server validation failed (network). Staying on page.');
    });
    // Expose token anyway so page can load while we validate
    window.NAIMOS_TOKEN = token;
  } else {
    // Token decoded and not expired — expose it immediately
    window.NAIMOS_TOKEN = token;
  }
 
  // ── FIX 5: Separate fetch patches (auth injection + 401 handler) ──────
 
  // Patch 1: Inject Authorization header for same-origin requests
  var _fetch1 = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    opts = Object.assign({}, opts || {});
    opts.headers = opts.headers || {};
 
    var urlStr = (typeof url === 'string') ? url : (url && url.url ? url.url : '');
    var isSameOrigin = urlStr.startsWith('/') || urlStr.startsWith(window.location.origin);
 
    if (isSameOrigin && window.NAIMOS_TOKEN) {
      if (opts.headers instanceof Headers) {
        if (!opts.headers.has('Authorization')) {
          opts.headers.set('Authorization', 'Bearer ' + window.NAIMOS_TOKEN);
        }
      } else if (!opts.headers['Authorization']) {
        opts.headers['Authorization'] = 'Bearer ' + window.NAIMOS_TOKEN;
      }
    }
    return _fetch1(url, opts);
  };
 
  // Patch 2: Auto-logout on 401 — but NOT for the ME_ENDPOINT itself
  // (prevents the server validation call above from triggering a loop)
  var _fetch2 = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var urlStr = (typeof url === 'string') ? url : (url && url.url ? url.url : '');
    return _fetch2(url, opts).then(function (response) {
      if (response.status === 401 && urlStr.indexOf(ME_ENDPOINT) === -1) {
        clearAllTokens();
        redirectToLogin();
      }
      return response;
    });
  };
 
  // ── Clear the redirect sentinel on successful guard pass ─────────────
  try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) {}
 
})();