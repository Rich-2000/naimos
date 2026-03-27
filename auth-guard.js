
(function () {
  'use strict';

  var PUBLIC_PATHS = ['/', '/login.html', '/reset-password.html', '/forgot-password.html'];
  var currentPath  = window.location.pathname;

  if (PUBLIC_PATHS.some(function (p) {
    return currentPath === p || currentPath.endsWith(p);
  })) {
    return;
  }

  var token = null;
  try {
    token = sessionStorage.getItem('naimos_token') || localStorage.getItem('naimos_token');
  } catch (e) { /* storage may be blocked */ }

  if (!token) {
    window.location.replace('/login.html');
    return;
  }

  // JWT expiry check (client-side early-exit only — server validates properly)
  try {
    var parts   = token.split('.');
    var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      try { sessionStorage.removeItem('naimos_token'); localStorage.removeItem('naimos_token'); } catch (e) {}
      window.location.replace('/login.html');
      return;
    }
  } catch (e) {
    try { sessionStorage.removeItem('naimos_token'); localStorage.removeItem('naimos_token'); } catch (e) {}
    window.location.replace('/login.html');
    return;
  }

  window.NAIMOS_TOKEN = token;

  // Patch fetch — ONLY inject Authorization for our own /api/* endpoints
  var _origFetch = window.fetch.bind(window);

  window.fetch = function (url, opts) {
    opts = opts || {};

    var urlStr = typeof url === 'string'
               ? url
               : url instanceof Request
               ? url.url
               : String(url);

    var isOurAPI = urlStr.startsWith('/api/')
                || urlStr.startsWith(window.location.origin + '/api/')
                || urlStr.startsWith('http://localhost:3001/api/')
                || urlStr.startsWith('http://127.0.0.1:3001/api/');

    if (isOurAPI && window.NAIMOS_TOKEN) {
      if (opts.headers instanceof Headers) {
        var h = new Headers(opts.headers);
        if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + window.NAIMOS_TOKEN);
        opts = Object.assign({}, opts, { headers: h });
      } else {
        var plainHeaders = Object.assign({}, opts.headers || {});
        if (!plainHeaders['Authorization']) {
          plainHeaders['Authorization'] = 'Bearer ' + window.NAIMOS_TOKEN;
        }
        opts = Object.assign({}, opts, { headers: plainHeaders });
      }
    }

    return _origFetch(url, opts).then(function (response) {
      // Only redirect on 401 from OUR API — never from Sentinel Hub, FIRMS, etc.
      if (response.status === 401 && isOurAPI) {
        try {
          sessionStorage.removeItem('naimos_token');
          localStorage.removeItem('naimos_token');
        } catch (e) {}
        window.location.replace('/login.html');
      }
      return response;
    });
  };

})();