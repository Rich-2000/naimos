/**
 * NAIMOS AMS — Frontend API Client  (api-client.js)
 * ─────────────────────────────────────────────────────────────────────────
 * Place this file at the PROJECT ROOT  (same level as index.html).
 * Add ONE line just before </body> in index.html:
 *
 *   <script src="/api-client.js"></script>
 *
 * This file:
 *  • Overrides every function that makes a direct third-party API call
 *  • Routes them all through the Node/TypeScript backend at /api/*
 *  • API keys NEVER leave the server
 *  • Works on localhost:3001 (backend serves everything) AND on Vercel
 *
 * REQUIRED changes in the index.html inline <script> block (6 lines):
 *   let geminiHistory     → window.geminiHistory     = []
 *   let firmsRawData      → window.firmsRawData      = []
 *   let firmsFilteredData → window.firmsFilteredData = []
 *   function appendMsg    → window.appendMsg         = function
 *   function scrollChat   → window.scrollChat        = function
 *   (add semicolons after the closing } of those two functions)
 * ─────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── Base URL auto-detection ─────────────────────────────────────────────
  // • localhost:3001  → backend IS the server, use relative /api
  // • localhost:*     → separate frontend dev server, proxy to :3001
  // • any other host  → production (Vercel), use relative /api
  const API_BASE = (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  ) && window.location.port !== '3001'
    ? 'http://localhost:3001/api'
    : '/api';

  // ── Abort-signal helper (same pattern as index.html) ───────────────────
  function makeSignal(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  // ── Core fetch wrapper ──────────────────────────────────────────────────
  // Returns the raw Response on success (so callers can call .json() or .blob()).
  // Throws a plain Error with a human-readable message on any failure.
  async function apiFetch(path, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 25000;
    const headers   = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});

    let resp;
    try {
      resp = await fetch(API_BASE + path, {
        method:  opts.method  || 'GET',
        headers: headers,
        body:    opts.body    || undefined,
        signal:  makeSignal(timeoutMs),
      });
    } catch (networkErr) {
      if (networkErr.name === 'AbortError') {
        throw new Error('Request timed out after ' + (timeoutMs / 1000) + 's. Is the backend running?');
      }
      throw new Error('Network error: ' + (networkErr.message || 'Could not reach backend'));
    }

    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try {
        const body = await resp.json();
        msg = body.error || body.message || msg;
      } catch (_) { /* body wasn't JSON */ }
      throw new Error(msg);
    }

    return resp; // caller decides .json() vs .blob() vs .text()
  }

  // ── Status-bar helpers (reuse the elements already in index.html) ───────
  function setFetchStatus(type, msg) {
    var el  = document.getElementById('firms-fetch-status');
    var txt = document.getElementById('firms-status-text');
    if (el)  el.className = 'fetch-status ' + type;
    if (txt) txt.textContent = msg;
  }

  function setSentinelStatus(type, msg) {
    var el = document.getElementById('sentinel-status');
    if (!el) return;
    el.className = 'fetch-status ' + type;
    var sp = el.querySelector('span');
    if (sp) sp.textContent = msg;
  }

  function setGEEStatus(type, msg) {
    var el = document.getElementById('gee-status');
    if (!el) return;
    el.className = 'fetch-status ' + type;
    var sp = el.querySelector('span');
    if (sp) sp.textContent = msg;
  }

  function setPCStatus(type, msg) {
    var el = document.getElementById('pc-status');
    if (!el) return;
    el.className = 'fetch-status ' + type;
    var sp = el.querySelector('span');
    if (sp) sp.textContent = msg;
  }

  function setBadge(id, text, ok) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent  = text;
    el.className    = ok ? 'proxy-badge ok' : 'proxy-badge warn';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1.  GEMINI AI CHAT   POST /api/chat
  // ══════════════════════════════════════════════════════════════════════════
  window.sendAIMessage = async function () {
    var input = document.getElementById('ai-input');
    var btn   = document.getElementById('send-btn');
    if (!input || !btn) return;

    var text = input.value.trim();
    if (!text) return;

    input.value  = '';
    btn.disabled = true;

    // appendMsg / scrollChat must be on window (see header notes)
    window.appendMsg(text, 'user');

    var typingEl = document.getElementById('typing-anim');
    if (typingEl) typingEl.classList.add('visible');
    window.scrollChat();

    window.geminiHistory = window.geminiHistory || [];
    window.geminiHistory.push({ role: 'user', parts: [{ text: text }] });
    if (window.geminiHistory.length > 20) {
      window.geminiHistory = window.geminiHistory.slice(-20);
    }

    try {
      var resp = await apiFetch('/chat', {
        method:    'POST',
        body:      JSON.stringify({ contents: window.geminiHistory }),
        timeoutMs: 30000,
      });
      var data  = await resp.json();
      var reply = (
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text
      ) || 'No content returned. Please retry.';

      window.geminiHistory.push({ role: 'model', parts: [{ text: reply }] });
      window.appendMsg(reply, 'ai');

    } catch (err) {
      window.geminiHistory.pop(); // remove the user message we pushed
      var msg = err.message || 'Unknown error';

      if (msg.includes('GEMINI_API_KEY') || msg.includes('not configured') || msg.includes('not set')) {
        window.appendMsg(
          '⚠ GEMINI_API_KEY not configured on the backend.\n\n' +
          'Add it to your .env file at the project root:\n' +
          'GEMINI_API_KEY=your_key_from_aistudio.google.com\n\n' +
          'Then restart the backend (npm run dev).',
          'ai'
        );
      } else if (msg.includes('timed out') || msg.includes('reach backend')) {
        window.appendMsg(
          '⚠ Cannot reach NAIMOS backend.\n\n' +
          'Make sure the backend is running:\n' +
          'cd backend && npm run dev',
          'ai'
        );
      } else {
        window.appendMsg('⚠ NAIMOS-AI offline.\n\nError: ' + msg + '\n\nTry again in a moment.', 'ai');
      }
    }

    if (typingEl) typingEl.classList.remove('visible');
    btn.disabled = false;
    window.scrollChat();
  };

  // sendQuickMsg is used by the quick-action buttons — keep it working
  window.sendQuickMsg = function (prompt) {
    var input = document.getElementById('ai-input');
    if (input) input.value = prompt;
    window.sendAIMessage();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 2.  NASA FIRMS   GET /api/firms
  // ══════════════════════════════════════════════════════════════════════════
  window.fetchFIRMSData = async function () {
    var keyInput = document.getElementById('firms-key-input');
    var daysEl   = document.getElementById('firms-days');
    var sensorEl = document.getElementById('firms-sensor');

    var key    = keyInput ? keyInput.value.trim() : '';
    var days   = daysEl   ? daysEl.value   : '7';
    var sensor = sensorEl ? sensorEl.value : 'VIIRS_SNPP_NRT';

    setFetchStatus('loading', '⟳ Fetching ' + days + '-day Ghana thermal data via NAIMOS backend (' + sensor + ')...');

    try {
      var params = new URLSearchParams({ days: days, sensor: sensor });
      if (key) params.set('key', key); // optional UI override of env key

      var resp    = await apiFetch('/firms?' + params.toString(), { timeoutMs: 25000 });
      var csvText = await resp.text();

      if (!csvText || csvText.trim().length < 30) {
        setFetchStatus('loading', '⚠ No thermal detections in Ghana for last ' + days + ' day(s). Try "Last 7 Days".');
        return;
      }

      window.firmsRawData = parseCSV(csvText);

      if (!window.firmsRawData.length) {
        setFetchStatus('loading', '⚠ CSV parsed but contained 0 valid rows. Check sensor/date selection.');
        return;
      }

      window.firmsRawData.forEach(function (r) {
        r.region = classifyRegion(r.lat, r.lon);
        r.risk   = galamseyRisk(r.frp, r.daynight, r.brightness);
      });
      window.firmsFilteredData = window.firmsRawData.slice();

      setFetchStatus('success',
        '✓ ' + window.firmsRawData.length + ' thermal hotspots loaded via backend · ' + new Date().toUTCString()
      );
      setBadge('proxy-firms', '⬤ FIRMS (' + window.firmsRawData.length + ')', true);

      updateFIRMSStats();
      renderFIRMSTable(window.firmsFilteredData);
      renderFIRMSCharts();
      injectFIRMSAlerts();

    } catch (err) {
      setFetchStatus('error', '✗ FIRMS error: ' + err.message);
      setBadge('proxy-firms', '✗ FIRMS', false);
      console.error('[NAIMOS] FIRMS fetch error:', err);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 3.  ESA SENTINEL HUB   GET /api/sentinel/image
  // ══════════════════════════════════════════════════════════════════════════
  window.loadSentinelLayer = async function (type, region) {
    var regionLabels = {
      western: 'Western Region (Tarkwa-Prestea)',
      ashanti: 'Ashanti Region (Obuasi-Kumawu)',
      ghana:   'All Ghana',
    };
    var label = regionLabels[region] || region;

    var imgEl     = document.getElementById('sentinel-img');
    var captionEl = document.getElementById('sentinel-caption');
    var phEl      = document.getElementById('sentinel-placeholder');
    var dateLabel = document.getElementById('sentinel-date-label');

    if (imgEl) imgEl.style.opacity = '0.2';
    setSentinelStatus('loading', '⟳ Loading ' + type.toUpperCase() + ' imagery for ' + label + ' via backend...');

    try {
      var params = new URLSearchParams({ layer: type, region: region, width: '768', height: '768' });
      var resp   = await apiFetch('/sentinel/image?' + params.toString(), { timeoutMs: 30000 });
      var blob   = await resp.blob();
      var url    = URL.createObjectURL(blob);

      if (imgEl) {
        imgEl.src           = url;
        imgEl.style.opacity = '1';
      }
      if (phEl)       phEl.style.display = 'none';
      if (dateLabel)  dateLabel.textContent = new Date().toUTCString().slice(0, 16);

      var typeLabels = {
        ndvi: 'NDVI (Red=Disturbed/Galamsey · Gold=Sparse · Green=Forest)',
        sar:  'SAR Backscatter (Red=High Disturbance · Green=Forest Cover)',
      };
      if (captionEl) {
        captionEl.textContent =
          'Sentinel ' + (type === 'ndvi' ? '2' : '1') + ' · ' +
          (typeLabels[type] || type.toUpperCase()) + ' · ' +
          label + ' · ' + new Date().toDateString();
      }

      setSentinelStatus('success', '✓ ' + type.toUpperCase() + ' imagery rendered · ' + label);
      setBadge('proxy-sentinel', '⬤ SENTINEL', true);

    } catch (err) {
      setSentinelStatus('error', '✗ Sentinel error: ' + err.message);
      if (imgEl) imgEl.style.opacity = '0.1';
      // Fall back to the existing helper in index.html
      if (typeof showSentinelFallback === 'function') {
        showSentinelFallback(type, [], label);
      }
      console.error('[NAIMOS] Sentinel error:', err);
    }
  };

  // getSentinelToken is still called by some UI code paths — return a dummy
  // so nothing crashes; the real token lives server-side now.
  window.getSentinelToken = async function () {
    try {
      var resp  = await apiFetch('/sentinel/token', { method: 'POST', timeoutMs: 10000 });
      var data  = await resp.json();
      setSentinelStatus('success', '✓ Sentinel Hub authenticated via backend');
      return data.access_token || null;
    } catch (err) {
      setSentinelStatus('error', '✗ Sentinel token: ' + err.message);
      throw err;
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 4.  GOOGLE EARTH ENGINE   GET /api/gee/ndvi
  // ══════════════════════════════════════════════════════════════════════════
  window.fetchGEENDVI = async function (bboxKey) {
    var regionEl = document.getElementById('gee-region');
    var region   = bboxKey || (regionEl ? regionEl.value : 'western');
    var label    = region.charAt(0).toUpperCase() + region.slice(1) + ' Region';

    setGEEStatus('loading', '⟳ Computing Sentinel-2 NDVI via GEE backend for ' + label + '...');

    try {
      var resp = await apiFetch('/gee/ndvi?region=' + encodeURIComponent(region), {
        timeoutMs: 45000,
      });

      // Headers may carry date-range info set by the backend
      var dateRange = resp.headers.get('X-GEE-DateRange') || '';
      var parts     = dateRange.split('/');
      var fromDt    = parts[0] || '—';
      var toDt      = parts[1] || '—';

      var blob = await resp.blob();
      var url  = URL.createObjectURL(blob);

      if (typeof displayGEEImage === 'function') {
        displayGEEImage(url, 'GEE Sentinel-2 NDVI · ' + label + ' · ' + fromDt + ' → ' + toDt);
      } else {
        // Fallback: set image directly
        var geeImg = document.getElementById('gee-img');
        var geeCap = document.getElementById('gee-caption');
        var geePh  = document.getElementById('gee-placeholder');
        if (geeImg) { geeImg.src = url; geeImg.style.opacity = '1'; }
        if (geePh)  geePh.style.display = 'none';
        if (geeCap) geeCap.textContent = 'GEE NDVI · ' + label + ' · ' + fromDt + ' → ' + toDt;
      }

      setGEEStatus('success', '✓ GEE NDVI computed for ' + label + ' · ' + fromDt + ' → ' + toDt);
      setBadge('proxy-gee', '⬤ GEE', true);

    } catch (err) {
      setGEEStatus('error', '✗ GEE error: ' + err.message);
      if (typeof showGEESetupGuide === 'function') showGEESetupGuide();
      console.error('[NAIMOS] GEE error:', err);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 5.  MICROSOFT PLANETARY COMPUTER   POST /api/planetary/search
  // ══════════════════════════════════════════════════════════════════════════

  // Internal helper used by all PC loaders
  async function _pcSearch(dataset, regionKey, days, label) {
    var resp = await apiFetch('/planetary/search', {
      method:    'POST',
      body:      JSON.stringify({ dataset: dataset, region: regionKey, days: days || 30, maxCloud: 40 }),
      timeoutMs: 20000,
    });
    return resp.json();
  }

  window.loadPCScenes = async function (dataset, regionKey) {
    var dsEl     = document.getElementById('pc-dataset');
    var regEl    = document.getElementById('pc-region');
    var ds       = dataset   || (dsEl  ? dsEl.value  : 's2');
    var region   = regionKey || (regEl ? regEl.value : 'western');
    var regionLabels = { western: 'Western Region', ashanti: 'Ashanti Region', ghana: 'All Ghana' };
    var label = regionLabels[region] || region;

    setPCStatus('loading', '⟳ Searching Planetary Computer for ' + ds.toUpperCase() + ' scenes over ' + label + '...');

    try {
      var data = await _pcSearch(ds, region, 30, label);

      if (!data.scenes || !data.scenes.length) {
        setPCStatus('loading', '⚠ No ' + ds.toUpperCase() + ' scenes found for ' + label + ' in last 30 days.');
        return;
      }

      setPCStatus('success',
        '✓ Found ' + (data.count || data.scenes.length) + ' ' + ds.toUpperCase() +
        ' scenes · ' + label +
        (data.fromDt ? ' · ' + data.fromDt + ' → ' + data.toDt : '')
      );
      renderPCSceneTable(data.scenes, ds, label);
      renderPCSceneChart(data.scenes, ds);

    } catch (err) {
      setPCStatus('error', '✗ Planetary Computer error: ' + err.message);
      console.error('[NAIMOS] PC scenes error:', err);
    }
  };

  window.loadPCLULC = async function (regionKey) {
    var regEl  = document.getElementById('pc-region');
    var region = regionKey || (regEl ? regEl.value : 'western');
    setPCStatus('loading', '⟳ Fetching Impact Observatory LULC for ' + region + '...');
    try {
      var data = await _pcSearch('lulc', region, 365);
      if (!data.scenes || !data.scenes.length) { setPCStatus('loading', '⚠ No LULC scenes found.'); return; }
      setPCStatus('success', '✓ LULC loaded · Class 1 = Bare Ground = Galamsey Risk');
      renderPCSceneTable(data.scenes, 'lulc', region);
    } catch (err) {
      setPCStatus('error', '✗ LULC error: ' + err.message);
    }
  };

  window.loadPCJRCWater = async function (regionKey) {
    var regEl  = document.getElementById('pc-region');
    var region = regionKey || (regEl ? regEl.value : 'western');
    setPCStatus('loading', '⟳ Fetching JRC Surface Water for ' + region + '...');
    try {
      var data = await _pcSearch('jrc', region, 365);
      if (!data.scenes || !data.scenes.length) { setPCStatus('loading', '⚠ No JRC water scenes found.'); return; }
      setPCStatus('success', '✓ JRC Surface Water: ' + (data.count || data.scenes.length) + ' scenes');
      renderPCSceneTable(data.scenes, 'jrc', region);
    } catch (err) {
      setPCStatus('error', '✗ JRC Water error: ' + err.message);
    }
  };

  window.loadPCForestAlerts = async function (regionKey) {
    var regEl  = document.getElementById('pc-region');
    var region = regionKey || (regEl ? regEl.value : 'ghana');
    setPCStatus('loading', '⟳ Fetching GLAD forest change alerts for ' + region + '...');
    try {
      var data = await _pcSearch('glad', region, 90);
      if (!data.scenes || !data.scenes.length) { setPCStatus('loading', '⚠ No GLAD alerts found.'); return; }
      setPCStatus('success', '✓ GLAD: ' + (data.count || data.scenes.length) + ' forest change alerts');
      renderPCSceneTable(data.scenes, 'glad', region);
    } catch (err) {
      setPCStatus('error', '✗ GLAD alerts error: ' + err.message);
    }
  };

  // SAS token — backend handles signing; this is called by downloadPCScene in index.html
  window.getPCToken = async function (dataset) {
    try {
      var resp = await apiFetch('/planetary/token/' + encodeURIComponent(dataset), { timeoutMs: 10000 });
      var data = await resp.json();
      return data.token || null;
    } catch (_) {
      return null; // graceful — STAC URLs still work without a token for public data
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 6.  BACKEND HEALTH CHECK   GET /api/health
  // ══════════════════════════════════════════════════════════════════════════
  async function checkBackendHealth() {
    var lastCheck = document.getElementById('proxy-last-check');
    if (lastCheck) lastCheck.textContent = 'Checking backend...';

    try {
      var resp   = await apiFetch('/health', { timeoutMs: 8000 });
      var health = await resp.json();

      // Map backend health keys → proxy-bar badge element IDs
      var badgeMap = {
        gemini:    { id: 'proxy-gemini',    label: '⬤ GEMINI AI'   },
        firms:     { id: 'proxy-firms',     label: '⬤ FIRMS'       },
        sentinel:  { id: 'proxy-sentinel',  label: '⬤ SENTINEL'    },
        gee:       { id: 'proxy-gee',       label: '⬤ GEE'         },
        planetary: { id: 'proxy-planetary', label: '⬤ PLANETARY'   },
      };

      for (var key in badgeMap) {
        var cfg    = badgeMap[key];
        var status = health[key] || 'unknown';
        // "configured", "live", "public*" = green; anything else = warn
        var ok = status === 'configured' || status === 'live' || status.indexOf('public') === 0;
        setBadge(cfg.id, cfg.label, ok);
      }

      if (lastCheck) {
        var now = new Date();
        lastCheck.textContent =
          'Backend ✓ · ' +
          String(now.getUTCHours()).padStart(2, '0') + ':' +
          String(now.getUTCMinutes()).padStart(2, '0') + ' UTC';
      }

    } catch (err) {
      if (lastCheck) lastCheck.textContent = 'Backend ✗ — is it running? (cd backend && npm run dev)';
      // Mark all badges as warn so the operator knows immediately
      ['proxy-gemini','proxy-firms','proxy-sentinel','proxy-gee','proxy-planetary'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.className = 'proxy-badge warn';
      });
      console.warn('[NAIMOS] Backend health check failed:', err.message);
    }
  }

  // Run on page load and refresh every 5 minutes
  window.addEventListener('load', function () {
    setTimeout(checkBackendHealth, 1500);
    setInterval(checkBackendHealth, 5 * 60 * 1000);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7.  CORS PROXY OVERRIDE — disable the old CORS proxy system
  //     The index.html inline script calls fetchWithCORSProxy in a few places.
  //     We replace it with a no-op that just calls the backend instead.
  // ══════════════════════════════════════════════════════════════════════════
  window.fetchWithCORSProxy = async function (targetUrl) {
    console.warn('[NAIMOS] fetchWithCORSProxy called directly — this should not happen. ' +
      'All requests should go through the backend. URL was: ' + targetUrl);
    // Attempt a direct fetch as last resort (will work on Vercel where backend is same origin)
    var resp = await fetch(targetUrl);
    if (!resp.ok) throw new Error('Direct fetch failed: HTTP ' + resp.status);
    return resp.text();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Init log
  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    '%c NAIMOS API Client v1 loaded ',
    'background:#00FF88;color:#000;font-weight:bold;font-size:12px;padding:2px 8px;border-radius:3px;'
  );
  console.log('%c API_BASE = ' + API_BASE, 'color:#00FF88;font-size:11px;');
  console.log('%c All third-party API calls routed through backend /api/*', 'color:#4A9EFF;font-size:11px;');

})();