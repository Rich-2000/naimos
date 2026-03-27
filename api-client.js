
(function () {
  'use strict';

  // ── FIX 4: API_BASE resolution (preserved from v2) ─────────────────────
  var isLocalhost = (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
  var API_BASE;
  if (isLocalhost && window.location.port !== '3001' && window.location.port !== '') {
    API_BASE = 'http://localhost:3001/api';
  } else {
    API_BASE = '/api';
  }
  window.API_BASE = API_BASE;

  // ── Abort-signal helper ─────────────────────────────────────────────────
  function makeSignal(ms) {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }

  // ── Core fetch wrapper — returns raw Response ───────────────────────────
  // FIX 1: Returns the Response object so callers can choose .json()/.text()/.blob()
  async function apiFetch(path, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 25000;
    var headers   = Object.assign({}, opts.headers || {});

    // Only set Content-Type for JSON bodies — don't force it for GET
    if (opts.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    var resp;
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
      var msg = 'HTTP ' + resp.status;
      try {
        var body = await resp.clone().json();
        msg = body.error || body.message || msg;
      } catch (_) { /* body wasn't JSON */ }
      throw new Error(msg);
    }

    return resp;
  }

  // ── Status-bar helpers ──────────────────────────────────────────────────
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
    el.textContent = text;
    el.className   = ok ? 'proxy-badge ok' : 'proxy-badge warn';
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

    if (typeof window.appendMsg === 'function') window.appendMsg(text, 'user');

    var typingEl = document.getElementById('typing-anim');
    if (typingEl) typingEl.classList.add('visible');
    if (typeof window.scrollChat === 'function') window.scrollChat();

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
      if (typeof window.appendMsg === 'function') window.appendMsg(reply, 'ai');

    } catch (err) {
      window.geminiHistory.pop();
      var errMsg = err.message || 'Unknown error';
      var displayMsg;

      if (errMsg.includes('GEMINI_API_KEY') || errMsg.includes('not configured') || errMsg.includes('not set')) {
        displayMsg = '⚠ GEMINI_API_KEY not configured on the backend.\n\nAdd it to your .env:\nGEMINI_API_KEY=your_key_from_aistudio.google.com\n\nThen restart the backend.';
      } else if (errMsg.includes('timed out') || errMsg.includes('reach backend')) {
        displayMsg = '⚠ Cannot reach NAIMOS backend.\n\nMake sure it is running:\ncd backend && npm run dev';
      } else {
        displayMsg = '⚠ NAIMOS-AI offline.\n\nError: ' + errMsg + '\n\nTry again in a moment.';
      }
      if (typeof window.appendMsg === 'function') window.appendMsg(displayMsg, 'ai');
    }

    if (typingEl) typingEl.classList.remove('visible');
    btn.disabled = false;
    if (typeof window.scrollChat === 'function') window.scrollChat();
  };

  window.sendQuickMsg = function (prompt) {
    var input = document.getElementById('ai-input');
    if (input) input.value = prompt;
    window.sendAIMessage();
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 2.  NASA FIRMS   GET /api/firms  (raw CSV via backend — no CORS proxy)
  //
  //  FIX 2: Automatically downgrades sensor for days > 5:
  //    VIIRS_SNPP_NRT  → max 5 days
  //    VIIRS_SNPP      → max 10 days (archive, no _NRT suffix)
  // ══════════════════════════════════════════════════════════════════════════
  window.fetchFIRMSData = async function () {
    var keyInput = document.getElementById('firms-key-input');
    var daysEl   = document.getElementById('firms-days');
    var sensorEl = document.getElementById('firms-sensor');

    var key    = keyInput ? keyInput.value.trim() : '';
    var days   = parseInt(daysEl ? daysEl.value : '2', 10) || 2;
    var sensor = sensorEl ? sensorEl.value : 'VIIRS_SNPP_NRT';

    // FIX 2: NRT sensors only support 1-5 days; auto-downgrade for longer ranges
    var NRT_SENSORS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'];
    if (NRT_SENSORS.indexOf(sensor) !== -1 && days > 5) {
      sensor = 'VIIRS_SNPP';   // archive variant — accepts up to 10 days
      console.info('[NAIMOS FIRMS] Auto-downgraded to VIIRS_SNPP for ' + days + '-day range');
    }

    setFetchStatus('loading', '⟳ Fetching ' + days + '-day Ghana thermal data via NAIMOS backend (' + sensor + ')...');

    try {
      var params = new URLSearchParams({ days: String(days), sensor: sensor });
      if (key) params.set('key', key);

      // FIX 1: apiFetch returns Response; call .text() here
      var resp    = await apiFetch('/firms?' + params.toString(), { timeoutMs: 25000 });
      var csvText = await resp.text();

      if (!csvText || csvText.trim().length < 30) {
        setFetchStatus('loading', '⚠ No thermal detections in Ghana for last ' + days + ' day(s). Try "Last 7 Days".');
        return;
      }

      window.firmsRawData = typeof parseCSV === 'function' ? parseCSV(csvText) : [];

      if (!window.firmsRawData.length) {
        setFetchStatus('loading', '⚠ CSV parsed but contained 0 valid rows. Check sensor/date selection.');
        return;
      }

      window.firmsRawData.forEach(function (r) {
        if (typeof classifyRegion === 'function') r.region = classifyRegion(r.lat, r.lon);
        if (typeof galamseyRisk   === 'function') r.risk   = galamseyRisk(r.frp, r.daynight, r.brightness);
      });
      window.firmsFilteredData = window.firmsRawData.slice();

      setFetchStatus('success',
        '✓ ' + window.firmsRawData.length + ' thermal hotspots loaded via backend · ' + new Date().toUTCString()
      );
      setBadge('proxy-firms', '⬤ FIRMS (' + window.firmsRawData.length + ')', true);

      if (typeof updateFIRMSStats  === 'function') updateFIRMSStats();
      if (typeof renderFIRMSTable  === 'function') renderFIRMSTable(window.firmsFilteredData);
      if (typeof renderFIRMSCharts === 'function') renderFIRMSCharts();
      if (typeof injectFIRMSAlerts === 'function') injectFIRMSAlerts();

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

      if (imgEl) { imgEl.src = url; imgEl.style.opacity = '1'; }
      if (phEl)       phEl.style.display = 'none';
      if (dateLabel)  dateLabel.textContent = new Date().toUTCString().slice(0, 16);

      var typeLabels = {
        ndvi: 'NDVI (Red=Disturbed/Galamsey · Gold=Sparse · Green=Forest)',
        sar:  'SAR Backscatter (Red=High Disturbance · Green=Forest Cover)',
      };
      if (captionEl) {
        captionEl.textContent =
          'Sentinel ' + (type === 'ndvi' ? '2' : '1') + ' · ' +
          (typeLabels[type] || type.toUpperCase()) + ' · ' + label + ' · ' + new Date().toDateString();
      }

      setSentinelStatus('success', '✓ ' + type.toUpperCase() + ' imagery rendered · ' + label);
      setBadge('proxy-sentinel', '⬤ SENTINEL', true);

    } catch (err) {
      setSentinelStatus('error', '✗ Sentinel error: ' + err.message);
      if (imgEl) imgEl.style.opacity = '0.1';
      if (typeof showSentinelFallback === 'function') showSentinelFallback(type, [], label);
      console.error('[NAIMOS] Sentinel error:', err);
    }
  };

  window.getSentinelToken = async function () {
    try {
      var resp = await apiFetch('/sentinel/token', { method: 'POST', timeoutMs: 10000 });
      var data = await resp.json();
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
      var resp = await apiFetch('/gee/ndvi?region=' + encodeURIComponent(region), { timeoutMs: 45000 });

      var dateRange = resp.headers.get('X-GEE-DateRange') || '';
      var parts     = dateRange.split('/');
      var fromDt    = parts[0] || '—';
      var toDt      = parts[1] || '—';

      var blob = await resp.blob();
      var url  = URL.createObjectURL(blob);

      if (typeof displayGEEImage === 'function') {
        displayGEEImage(url, 'GEE Sentinel-2 NDVI · ' + label + ' · ' + fromDt + ' → ' + toDt);
      } else {
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
  async function _pcSearch(dataset, regionKey, days) {
    var resp = await apiFetch('/planetary/search', {
      method:    'POST',
      body:      JSON.stringify({ dataset: dataset, region: regionKey, days: days || 30, maxCloud: 40 }),
      timeoutMs: 20000,
    });
    return resp.json();
  }

  window.loadPCScenes = async function (dataset, regionKey) {
    var dsEl   = document.getElementById('pc-dataset');
    var regEl  = document.getElementById('pc-region');
    var ds     = dataset   || (dsEl  ? dsEl.value  : 's2');
    var region = regionKey || (regEl ? regEl.value : 'western');

    var regionLabels = { western: 'Western Region', ashanti: 'Ashanti Region', ghana: 'All Ghana' };
    var label = regionLabels[region] || region;

    setPCStatus('loading', '⟳ Searching Planetary Computer for ' + ds.toUpperCase() + ' scenes over ' + label + '...');

    try {
      var data = await _pcSearch(ds, region, 30);
      if (!data.scenes || !data.scenes.length) {
        setPCStatus('loading', '⚠ No ' + ds.toUpperCase() + ' scenes found for ' + label + ' in last 30 days.');
        return;
      }
      setPCStatus('success',
        '✓ Found ' + (data.count || data.scenes.length) + ' ' + ds.toUpperCase() +
        ' scenes · ' + label +
        (data.fromDt ? ' · ' + data.fromDt + ' → ' + data.toDt : '')
      );
      if (typeof renderPCSceneTable === 'function') renderPCSceneTable(data.scenes, ds, label);
      if (typeof renderPCSceneChart === 'function') renderPCSceneChart(data.scenes, ds);
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
      if (typeof renderPCSceneTable === 'function') renderPCSceneTable(data.scenes, 'lulc', region);
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
      if (typeof renderPCSceneTable === 'function') renderPCSceneTable(data.scenes, 'jrc', region);
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
      if (typeof renderPCSceneTable === 'function') renderPCSceneTable(data.scenes, 'glad', region);
    } catch (err) {
      setPCStatus('error', '✗ GLAD alerts error: ' + err.message);
    }
  };

  window.getPCToken = async function (dataset) {
    try {
      var resp = await apiFetch('/planetary/token/' + encodeURIComponent(dataset), { timeoutMs: 10000 });
      var data = await resp.json();
      return data.token || null;
    } catch (_) {
      return null;
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 6.  FIX 3: refreshIntelDatabase — replaces the broken direct calls
  //     to catalogue.dataspace.copernicus.eu and allorigins.win.
  //     Now calls /api/firms and /api/planetary/stac through the backend.
  // ══════════════════════════════════════════════════════════════════════════
  window.refreshIntelDatabase = async function (opts) {
    opts = opts || {};
    var region = opts.region || 'ghana';
    var days   = opts.days   || 2;

    var result = {
      firms:    { ok: false, count: 0 },
      sentinel: { ok: false, count: 0 },
    };

    // FIRMS
    try {
      var firmsParams = new URLSearchParams({ sensor: 'VIIRS_SNPP_NRT', days: String(days) });
      var firmsResp   = await apiFetch('/firms/geojson?' + firmsParams.toString(), { timeoutMs: 25000 });
      var geo         = await firmsResp.json();
      result.firms    = { ok: true, count: (geo.features || []).length };
      console.log('[NAIMOS FIRMS] ' + result.firms.count + ' detections loaded');
    } catch (err) {
      console.warn('[NAIMOS FIRMS] failed:', err.message);
      result.firms = { ok: false, count: 0, error: err.message };
    }

    // Sentinel (via Planetary Computer)
    try {
      var stacParams = new URLSearchParams({
        dataset:  's2',
        region:   region,
        maxCloud: '40',
        limit:    '10',
      });
      var stacResp  = await apiFetch('/planetary/stac?' + stacParams.toString(), { timeoutMs: 20000 });
      var stacData  = await stacResp.json();
      result.sentinel = { ok: true, count: stacData.count || 0 };
      console.log('[NAIMOS Sentinel] ' + result.sentinel.count + ' scenes via backend proxy');
    } catch (err) {
      console.warn('[NAIMOS Sentinel] failed:', err.message);
      result.sentinel = { ok: false, count: 0, error: err.message };
    }

    return result;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 7.  BACKEND HEALTH CHECK   GET /api/health
  // ══════════════════════════════════════════════════════════════════════════
  async function checkBackendHealth() {
    var lastCheck = document.getElementById('proxy-last-check');
    if (lastCheck) lastCheck.textContent = 'Checking backend...';

    try {
      var resp   = await apiFetch('/health', { timeoutMs: 8000 });
      var health = await resp.json();

      var badgeMap = {
        gemini:    { id: 'proxy-gemini',    label: '⬤ GEMINI AI' },
        firms:     { id: 'proxy-firms',     label: '⬤ FIRMS'     },
        sentinel:  { id: 'proxy-sentinel',  label: '⬤ SENTINEL'  },
        gee:       { id: 'proxy-gee',       label: '⬤ GEE'       },
        planetary: { id: 'proxy-planetary', label: '⬤ PLANETARY' },
      };

      for (var key in badgeMap) {
        var cfg    = badgeMap[key];
        var status = health[key] || 'unknown';
        var ok     = status === 'configured' || status === 'live' || status.indexOf('public') === 0;
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
      if (lastCheck) lastCheck.textContent = 'Backend ✗ — is it running?';
      ['proxy-gemini','proxy-firms','proxy-sentinel','proxy-gee','proxy-planetary'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.className = 'proxy-badge warn';
      });
      console.warn('[NAIMOS] Backend health check failed:', err.message);
    }
  }

  // Run on load, then every 2 minutes
  window.addEventListener('load', function () {
    setTimeout(checkBackendHealth, 1500);
    setInterval(checkBackendHealth, 2 * 60 * 1000);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8.  fetchWithCORSProxy — FIX 5: no-op stub (CSP blocks direct calls)
  // ══════════════════════════════════════════════════════════════════════════
  window.fetchWithCORSProxy = async function (targetUrl) {
    console.warn(
      '[NAIMOS] fetchWithCORSProxy() called — this is a legacy stub. ' +
      'Route this request through the backend /api/* instead. URL:', targetUrl
    );
    throw new Error('fetchWithCORSProxy is disabled. Use the backend proxy: ' + targetUrl);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Init log
  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    '%c NAIMOS API Client v3 loaded ',
    'background:#00FF88;color:#000;font-weight:bold;font-size:12px;padding:2px 8px;border-radius:3px;'
  );
  console.log('%c API_BASE = ' + API_BASE, 'color:#00FF88;font-size:11px;');
  console.log('%c All third-party API calls routed through backend /api/*', 'color:#4A9EFF;font-size:11px;');

})();