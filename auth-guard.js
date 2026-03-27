/**
 * ============================================================
 *  NAIMOS AMS — Client-Side Auth Guard
 *  Paste this as the VERY FIRST <script> block inside <head>
 *  in your index.html (before any other scripts).
 *
 *  It will redirect unauthenticated users to login.html
 *  before the rest of the page loads, preventing any flash
 *  of protected content.
 * ============================================================
 */
(function () {
  'use strict';

  var PUBLIC_PATHS = ['/login.html', '/reset-password.html'];
  var currentPath  = window.location.pathname;

  // Do not guard the login page itself
  if (PUBLIC_PATHS.some(function(p) { return currentPath === p || currentPath.endsWith(p); })) {
    return;
  }

  // Read token from storage
  var token = null;
  try {
    token = sessionStorage.getItem('naimos_token') || localStorage.getItem('naimos_token');
  } catch (e) { /* blocked storage */ }

  if (!token) {
    // No token — redirect immediately (no flash of protected content)
    window.location.replace('/login.html');
    return;
  }

  // Optionally: basic JWT expiry check without a library
  try {
    var parts   = token.split('.');
    var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      // Token expired — clear and redirect
      try { sessionStorage.removeItem('naimos_token'); localStorage.removeItem('naimos_token'); } catch(e){}
      window.location.replace('/login.html');
      return;
    }
  } catch (e) {
    // Malformed token — redirect
    try { sessionStorage.removeItem('naimos_token'); localStorage.removeItem('naimos_token'); } catch(e){}
    window.location.replace('/login.html');
    return;
  }

  // Token looks valid — expose it for API calls
  window.NAIMOS_TOKEN = token;

  // ── Attach token to all fetch calls automatically ──────────────────────────
  var _origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};

    // Only inject for same-origin or our own API
    var urlStr = typeof url === 'string' ? url : (url.url || '');
    var isSameOrigin = urlStr.startsWith('/') || urlStr.startsWith(window.location.origin);
    if (isSameOrigin && window.NAIMOS_TOKEN) {
      if (opts.headers instanceof Headers) {
        if (!opts.headers.has('Authorization')) {
          opts.headers.set('Authorization', 'Bearer ' + window.NAIMOS_TOKEN);
        }
      } else {
        opts.headers['Authorization'] = opts.headers['Authorization'] || ('Bearer ' + window.NAIMOS_TOKEN);
      }
    }
    return _origFetch(url, opts);
  };

  // ── Auto-logout on 401 responses ──────────────────────────────────────────
  var _origFetch2 = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    return _origFetch2(url, opts).then(function (response) {
      if (response.status === 401) {
        try { sessionStorage.removeItem('naimos_token'); localStorage.removeItem('naimos_token'); } catch(e){}
        window.location.replace('/login.html');
      }
      return response;
    });
  };

})();