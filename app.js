// County GDP by Industry — client app
// MD5-sharded detail data with industry breakdown and yearly trend charts
// Three search modes: county name, state browse, proximity

(function () {
  'use strict';

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  const DATA_BASE = 'data';
  const DETAIL_SHARDS = 256;

  // ── State ──
  let meta = null;
  let searchCache = {};
  let detailCache = {};
  let stateCache = {};
  let proxCache = {};
  let allCounties = null;       // flat list for state dropdown
  let lastResults = [];
  let currentDetail = null;

  // ── Formatting helpers ──
  function fmtGDP(val) {
    if (val == null) return '—';
    const millions = val / 1000;
    if (millions >= 1e6) return '$' + (millions / 1e6).toFixed(1) + 'T';
    if (millions >= 1000) return '$' + (millions / 1000).toFixed(1) + 'B';
    if (millions >= 1) return '$' + millions.toFixed(1) + 'M';
    return '$' + (val).toLocaleString() + 'K';
  }

  function fmtGDPcompact(val) {
    if (val == null) return '—';
    const millions = val / 1000;
    if (millions >= 1e6) return '$' + (millions / 1e6).toFixed(2) + ' trillion';
    if (millions >= 1000) return '$' + (millions / 1000).toFixed(1) + ' billion';
    if (millions >= 1) return '$' + millions.toFixed(0) + ' million';
    return '$' + (val).toLocaleString() + ' thousand';
  }

  // ── Init ──
  async function init() {
    try {
      const resp = await fetch(`${DATA_BASE}/meta.json`);
      meta = await resp.json();
      renderIntro();
      populateStates();
    } catch (e) {
      console.error('Failed to load meta:', e);
      $('#intro-stats').innerHTML = '<p>Loading data…</p>';
    }
  }

  function renderIntro() {
    if (!meta) return;
    const gdpStr = meta.national_total_gdp
      ? (meta.national_total_gdp / 1e6).toFixed(1) + ' trillion'
      : '—';
    const medianStr = meta.national_median_gdp
      ? (meta.national_median_gdp / 1000).toFixed(1) + ' billion'
      : '—';
    $('#intro-stats').innerHTML = `
      <div class="stat"><span class="stat-value">${meta.total_counties ? meta.total_counties.toLocaleString() : '—'}</span> counties</div>
      <div class="stat"><span class="stat-value">$${gdpStr}</span> total U.S. GDP (2024)</div>
      <div class="stat"><span class="stat-value">$${medianStr}</span> national median county GDP</div>
      <p class="intro-text">The Bureau of Economic Analysis tracks GDP for every U.S. county across 15 major industries. See what drives your local economy — from manufacturing and agriculture to professional services and government, with 24-year trends from 2001 to 2024. Search by county name, browse by state, or find economic data near any address.</p>
    `;
  }

  async function populateStates() {
    try {
      const resp = await fetch(`${DATA_BASE}/search/a.json`);
      const data = await resp.json();
      // Collect unique states from all letter indices
      const states = new Set();
      // Load all letter indices in parallel
      const letters = meta.index_letters || [];
      const promises = letters.map(l =>
        fetch(`${DATA_BASE}/search/${l.toLowerCase()}.json`).then(r => r.json())
      );
      const all = await Promise.all(promises);
      all.forEach(d => {
        d.counties.forEach(c => {
          if (c.state) states.add(c.state);
        });
      });
      const sorted = [...states].sort();
      const sel = $('#state-select');
      sorted.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to populate states:', e);
    }
  }

  // ── Tab switching ──
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.search-panel').forEach(p => p.classList.remove('active'));
      $(`#${btn.dataset.tab}-search`).classList.add('active');
    });
  });

  // ── Name search ──
  let searchTimeout = null;
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = $('#search-input').value.trim();
    if (q.length < 1) {
      $('#search-results').innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(() => doNameSearch(q), 150);
  });

  async function doNameSearch(q) {
    const first = q[0].toLowerCase();
    if (!/[a-z]/.test(first)) return;

    if (!searchCache[first]) {
      try {
        const resp = await fetch(`${DATA_BASE}/search/${first}.json`);
        searchCache[first] = await resp.json();
      } catch (e) {
        $('#search-results').innerHTML = '<p class="no-results">No results.</p>';
        return;
      }
    }

    const data = searchCache[first];
    const qLower = q.toLowerCase();
    let matches = data.counties.filter(c =>
      c.name.toLowerCase().includes(qLower)
    );

    matches.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(qLower);
      const bStarts = b.name.toLowerCase().startsWith(qLower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    });

    lastResults = matches.slice(0, 50);
    renderSearchResults(lastResults);
  }

  function renderSearchResults(results) {
    if (!results.length) {
      $('#search-results').innerHTML = '<p class="no-results">No counties found.</p>';
      return;
    }
    let html = '';
    results.forEach(c => {
      const gdp = fmtGDP(c.total_gdp);
      const yoy = c.yoy_change != null
        ? (c.yoy_change > 0 ? '↑' : c.yoy_change < 0 ? '↓' : '→') + ' ' + Math.abs(c.yoy_change).toFixed(1) + '%'
        : '';
      html += `<div class="result-card" data-fips="${c.fips}">
        <div class="result-name">${c.name}, ${c.state}</div>
        <div class="result-meta">GDP: <strong>${gdp}</strong> ${yoy ? '<span class="yoy">' + yoy + '</span>' : ''}</div>
      </div>`;
    });
    $('#search-results').innerHTML = html;

    $$('.result-card', $('#search-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  // ── State browse ──
  $('#state-select').addEventListener('change', async () => {
    const state = $('#state-select').value;
    if (!state) {
      $('#state-results').innerHTML = '';
      return;
    }

    if (!stateCache[state]) {
      try {
        const resp = await fetch(`${DATA_BASE}/states/${state.toLowerCase()}.json`);
        stateCache[state] = await resp.json();
      } catch (e) {
        $('#state-results').innerHTML = '<p class="no-results">No data for this state.</p>';
        return;
      }
    }

    const data = stateCache[state];
    lastResults = data.counties;
    renderStateResults(data);
  });

  function renderStateResults(data) {
    let html = `<h3>${data.state_name} — ${data.count} counties, ranked by GDP</h3>`;
    if (!data.counties.length) {
      html += '<p class="no-results">No counties found.</p>';
      $('#state-results').innerHTML = html;
      return;
    }
    data.counties.forEach((c, i) => {
      const gdp = fmtGDP(c.total_gdp);
      const yoy = c.yoy_change != null
        ? (c.yoy_change > 0 ? '↑' : c.yoy_change < 0 ? '↓' : '→') + ' ' + Math.abs(c.yoy_change).toFixed(1) + '%'
        : '';
      html += `<div class="result-card" data-fips="${c.fips}">
        <div class="result-rank">${i + 1}.</div>
        <div class="result-info">
          <div class="result-name">${c.name}</div>
          <div class="result-meta">GDP: <strong>${gdp}</strong> ${yoy ? '<span class="yoy">' + yoy + '</span>' : ''}</div>
        </div>
      </div>`;
    });
    $('#state-results').innerHTML = html;

    $$('.result-card', $('#state-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  // ── Proximity search ──
  $('#nearby-btn').addEventListener('click', doNearbySearch);
  $('#addr-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doNearbySearch();
  });

  async function doNearbySearch() {
    const addr = $('#addr-input').value.trim();
    if (!addr) return;

    $('#nearby-results').innerHTML = '<p class="loading">Geocoding address…</p>';

    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1&countrycodes=us`
      );
      const geoData = await geoResp.json();
      if (!geoData.length) {
        $('#nearby-results').innerHTML = '<p class="no-results">Address not found. Try a city name or ZIP code.</p>';
        return;
      }

      const lat = parseFloat(geoData[0].lat);
      const lon = parseFloat(geoData[0].lon);
      const displayName = geoData[0].display_name;
      const radius = parseFloat($('#radius-select').value);

      $('#nearby-results').innerHTML = `<p class="loading">Searching within ${radius} miles of ${displayName.split(',')[0]}…</p>`;

      // Load all proximity files and filter
      const allCounties = [];
      const proxStates = meta ? (await loadAllProx()) : [];
      for (const state of proxStates) {
        if (!proxCache[state]) {
          try {
            const resp = await fetch(`${DATA_BASE}/proximity/${state.toLowerCase()}.json`);
            proxCache[state] = await resp.json();
          } catch (e) { continue; }
        }
        for (const c of proxCache[state]) {
          const d = haversineKm(lat, lon, c.lat, c.lon);
          const dMi = d * 0.621371;
          if (dMi <= radius) {
            allCounties.push({ ...c, distance: dMi });
          }
        }
      }

      allCounties.sort((a, b) => a.distance - b.distance);
      lastResults = allCounties.slice(0, 50);
      renderProxResults(allCounties.slice(0, 50), displayName);
    } catch (e) {
      console.error(e);
      $('#nearby-results').innerHTML = '<p class="no-results">Search failed. Try again.</p>';
    }
  }

  async function loadAllProx() {
    // Get list of states with proximity data from the first search index
    const states = new Set();
    const letters = meta.index_letters || ['a'];
    for (const l of letters.slice(0, 3)) {
      try {
        const resp = await fetch(`${DATA_BASE}/search/${l.toLowerCase()}.json`);
        const data = await resp.json();
        data.counties.forEach(c => { if (c.state) states.add(c.state); });
      } catch (e) {}
    }
    return [...states];
  }

  function renderProxResults(results, addr) {
    if (!results.length) {
      $('#nearby-results').innerHTML = '<p class="no-results">No counties found within this radius.</p>';
      return;
    }
    let html = `<p class="prox-label">Counties near ${addr.split(',')[0]}:</p>`;
    results.forEach(c => {
      const gdp = fmtGDP(c.total_gdp);
      html += `<div class="result-card" data-fips="${c.fips}">
        <div class="result-name">${c.name}, ${c.state} <span class="distance">${c.distance.toFixed(1)} mi</span></div>
        <div class="result-meta">GDP: <strong>${gdp}</strong></div>
      </div>`;
    });
    $('#nearby-results').innerHTML = html;

    $$('.result-card', $('#nearby-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Detail loading ──
  async function loadDetail(fips) {
    const shard = md5Shard(fips);
    if (!detailCache[fips]) {
      if (!detailCache._shards) detailCache._shards = {};
      if (!detailCache._shards[shard]) {
        try {
          const resp = await fetch(`${DATA_BASE}/details/${shard}.json`);
          detailCache._shards[shard] = await resp.json();
        } catch (e) {
          console.error('Failed to load detail shard:', e);
          return;
        }
      }
      detailCache[fips] = detailCache._shards[shard][fips];
    }

    const d = detailCache[fips];
    if (!d) return;
    currentDetail = d;

    renderDetail(d);
    $('#intro').classList.add('hidden');
    $$('.search-panel').forEach(p => p.classList.add('hidden'));
    $('#detail').classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // ── MD5 (matches Python hashlib.md5) ──
  function md5Shard(key) {
    return md5hex(key).substring(0, 2);
  }

  function md5hex(str) {
    function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
    function add32(a, b) { return ((a + b) & 0xFFFFFFFF) >>> 0; }

    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;

    const padded = new Uint8Array(((len + 8) >>> 6 << 6) + 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (len * 8) % 0x100000000, true);
    view.setUint32(padded.length - 4, Math.floor(len * 8 / 0x100000000), true);

    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

    const K = [];
    for (let i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }
    const S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
               5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
               4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
               6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];

    const words = new Uint32Array(padded.buffer);
    for (let i = 0; i < words.length; i += 16) {
      let A = a, B = b, C = c, D = d;
      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16) { F = (B & C) | (~B & D); g = j; }
        else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * j) % 16; }
        F = (F + A + K[j] + words[i + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[j])) >>> 0;
      }
      a = (a + A) >>> 0;
      b = (b + B) >>> 0;
      c = (c + C) >>> 0;
      d = (d + D) >>> 0;
    }

    function hex(v) { return ('00' + v.toString(16)).slice(-2); }
    const harr = new Uint8Array(16);
    const hview = new DataView(harr.buffer);
    hview.setUint32(0, a, true);
    hview.setUint32(4, b, true);
    hview.setUint32(8, c, true);
    hview.setUint32(12, d, true);
    return [...harr].map(b => hex(b)).join('');
  }

  // ── Detail rendering ──
  function renderDetail(d) {
    const totalGDP = d.total_gdp;
    const gdpStr = fmtGDPcompact(totalGDP);
    const yoyStr = d.yoy_change != null
      ? (d.yoy_change > 0 ? '+' : '') + d.yoy_change.toFixed(1) + '%'
      : '—';
    const yoyClass = d.yoy_change != null
      ? (d.yoy_change > 0.5 ? 'up' : d.yoy_change < -0.5 ? 'down' : 'flat')
      : '';

    // National median comparison
    let medianHTML = '';
    if (totalGDP != null && meta && meta.national_median_gdp != null) {
      const diff = totalGDP - meta.national_median_gdp;
      const pctAbove = meta.national_median_gdp > 0 ? Math.round(diff / meta.national_median_gdp * 100) : 0;
      const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '';
      const cls = diff > 0 ? 'above' : diff < 0 ? 'below' : 'at';
      medianHTML = `<p>National median county GDP: <strong>${fmtGDPcompact(meta.national_median_gdp)}</strong> — this county is <span class="comp-${cls}"><strong>${arrow} ${Math.abs(pctAbove)}% ${cls}</strong></span> the national median</p>`;
    }

    // Industry breakdown
    let industriesHTML = '';
    if (d.industries && Object.keys(d.industries).length > 0) {
      // Filter out aggregate codes (1, 2) and sort by value descending
      const industryList = Object.entries(d.industries)
        .filter(([code]) => code !== '1' && code !== '2')
        .sort((a, b) => (b[1].value || 0) - (a[1].value || 0));

      industriesHTML = '<h3>Industry Breakdown (2024)</h3><div class="industry-list">';
      industryList.forEach(([code, ind]) => {
        const pct = totalGDP ? (ind.value / totalGDP * 100).toFixed(1) : '0.0';
        const barWidth = totalGDP ? Math.max(1, (ind.value / totalGDP * 100)) : 0;
        industriesHTML += `
          <div class="industry-row">
            <div class="industry-label">${ind.label}</div>
            <div class="industry-bar-container">
              <div class="industry-bar" style="width:${barWidth}%"></div>
            </div>
            <div class="industry-value">${fmtGDP(ind.value)} <span class="industry-pct">(${pct}%)</span></div>
          </div>`;
      });
      industriesHTML += '</div>';
    }

    let html = `
      <h2>${d.name}, ${d.state_name}</h2>
      <div class="detail-stats">
        <div class="big-stat">
          <span class="big-num">${gdpStr}</span>
          <span class="big-label">total GDP (2024)</span>
        </div>
        ${d.yoy_change != null ? `<div class="big-stat sub">
          <span class="big-num yoy-${yoyClass}">${yoyStr}</span>
          <span class="big-label">year-over-year change</span>
        </div>` : ''}
      </div>

      ${medianHTML}
      ${industriesHTML}

      <h3>GDP Trend (2001–2024)</h3>
      ${d.yearly && d.yearly.length > 1 ? `<div class="chart-container"><canvas id="trend-chart"></canvas></div>` : '<p>Not enough yearly data for trend chart.</p>'}

      <p class="data-note">Data: U.S. Bureau of Economic Analysis. GDP figures in thousands of chained 2017 dollars. Industry breakdown shows 2-digit NAICS categories. Government and government enterprises includes federal, state, and local.</p>
    `;

    $('#detail-content').innerHTML = html;

    if (d.yearly && d.yearly.length > 1) {
      setTimeout(() => drawChart(d), 100);
    }
  }

  // ── Chart drawing ──
  function drawChart(detail) {
    const canvas = $('#trend-chart');
    if (!canvas) return;

    const container = canvas.parentElement;
    const width = container.clientWidth;
    const height = Math.max(300, Math.min(width * 0.5, 400));

    canvas.width = width * 2;
    canvas.height = height * 2;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    const padding = { top: 20, right: 30, bottom: 50, left: 60 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const yearly = detail.yearly.filter(y => y.value != null);
    if (yearly.length < 2) return;

    const values = yearly.map(y => y.value);
    const minVal = Math.floor(Math.min(...values) / 100000) * 100000;
    const maxVal = Math.ceil(Math.max(...values) / 100000) * 100000;
    const range = maxVal - minVal || 1;

    const xScale = i => padding.left + (i / (yearly.length - 1)) * chartW;
    const yScale = v => padding.top + chartH - ((v - minVal) / range) * chartH;

    // Background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    // Horizontal grid lines
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 0.5;
    const numGridLines = 5;
    for (let i = 0; i <= numGridLines; i++) {
      const v = minVal + (range / numGridLines) * i;
      const y = yScale(v);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();
      // Label
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      const label = v >= 1e6
        ? '$' + (v / 1e6).toFixed(1) + 'T'
        : '$' + (v / 1000).toFixed(0) + 'B';
      ctx.fillText(label, padding.left - 6, y + 4);
    }

    // Data line
    ctx.strokeStyle = '#2a6496';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    yearly.forEach((y, i) => {
      const x = xScale(i);
      const py = yScale(y.value);
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.stroke();

    // Area fill under line
    ctx.fillStyle = 'rgba(42, 100, 150, 0.08)';
    ctx.beginPath();
    yearly.forEach((y, i) => {
      const x = xScale(i);
      const py = yScale(y.value);
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    });
    ctx.lineTo(xScale(yearly.length - 1), yScale(minVal));
    ctx.lineTo(xScale(0), yScale(minVal));
    ctx.closePath();
    ctx.fill();

    // Data points
    yearly.forEach((y, i) => {
      const x = xScale(i);
      const py = yScale(y.value);
      ctx.fillStyle = '#2a6496';
      ctx.beginPath();
      ctx.arc(x, py, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // X-axis labels (show every 3rd year)
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    yearly.forEach((y, i) => {
      if (i % 3 === 0 || i === yearly.length - 1) {
        const x = xScale(i);
        ctx.fillText(y.year, x, padding.top + chartH + 16);
      }
    });

    // Axis labels
    ctx.fillStyle = '#888';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Year', padding.left + chartW / 2, padding.top + chartH + 38);
    ctx.save();
    ctx.translate(14, padding.top + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('GDP (chained 2017 dollars)', 0, 0);
    ctx.restore();
  }

  // ── Back button ──
  $('#back-btn').addEventListener('click', () => {
    $('#detail').classList.add('hidden');
    $('#intro').classList.remove('hidden');
    const activeTab = $('.tab.active');
    if (activeTab) {
      $$('.search-panel').forEach(p => p.classList.remove('active'));
      const panelId = activeTab.dataset.tab + '-search';
      const panel = $('#' + panelId);
      if (panel) panel.classList.add('active');
    }
    window.scrollTo(0, 0);
  });

  // ── Start ──
  init();
})();
