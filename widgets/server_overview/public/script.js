/* global Homey */

function onHomeyReady(Homey) {
  const settings = Homey.getSettings() || {};
  const refreshSeconds = Math.max(2, Math.min(60, Number(settings.refreshSeconds) || 5));

  const $ = (id) => document.getElementById(id);
  const lastValues = {};

  const LS_KEY = 'homeyfin.server_overview.server';
  let pollTimer = null;
  let announcedReady = false;
  let refreshing = false;
  let serverId = null;
  try { serverId = localStorage.getItem(LS_KEY) || null; } catch (e) { /* storage unavailable */ }

  // Posters travel only once per item: the API skips the data URI for keys
  // (`itemId:imageTag`) we report as already cached. Small FIFO cap keeps
  // webview memory bounded.
  const POSTER_CACHE_MAX = 20;
  const posterCache = new Map();
  function cachePoster(key, uri) {
    if (posterCache.has(key)) posterCache.delete(key);
    posterCache.set(key, uri);
    while (posterCache.size > POSTER_CACHE_MAX) {
      posterCache.delete(posterCache.keys().next().value);
    }
  }

  function serverQuery(extra) {
    const params = [];
    if (serverId) params.push(`serverId=${encodeURIComponent(serverId)}`);
    for (const [k, v] of Object.entries(extra || {})) {
      if (v) params.push(`${k}=${encodeURIComponent(v)}`);
    }
    return params.length ? '?' + params.join('&') : '';
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtCount(n) {
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return String(n ?? 0);
  }

  function setStat(id, value) {
    const el = $(id);
    const next = fmtCount(value);
    if (el.textContent !== next) {
      el.textContent = next;
      if (lastValues[id] !== undefined) {
        el.classList.remove('bumped');
        // re-trigger animation
        void el.offsetWidth;
        el.classList.add('bumped');
      }
    }
    lastValues[id] = value;
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[parts.length - 1][0]);
  }

  function userColor(seed) {
    // Stable HSL hue from name
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    const h = Math.abs(hash) % 360;
    return `linear-gradient(135deg, hsl(${h}, 65%, 55%), hsl(${(h + 60) % 360}, 65%, 45%))`;
  }

  function render(data) {
    const root = $('root');
    root.classList.remove('loading');

    if (data.server) {
      $('server-name').textContent = data.server.name || 'Jellyfin';
      $('server-sub').textContent = data.server.baseUrl || '';
    } else {
      $('server-name').textContent = 'No server';
      $('server-sub').textContent = 'Pair a Jellyfin server first';
    }

    const statusDot = document.querySelector('.status .dot');
    const statusText = $('status-text');
    statusDot.classList.remove('online', 'offline');
    if (data.online) {
      statusDot.classList.add('online');
      statusText.textContent = 'online';
    } else {
      statusDot.classList.add('offline');
      statusText.textContent = 'offline';
    }

    setStat('stat-active',   (data.activeCount || 0) + (data.pausedCount || 0));
    setStat('stat-movies',   data.counts.movies);
    setStat('stat-series',   data.counts.series);
    setStat('stat-episodes', data.counts.episodes);

    // Split sub-line: "X playing · Y paused · Z transcoding"
    const split = $('split');
    const parts = [];
    if (data.activeCount) parts.push(`<span class="pulse"><b>${data.activeCount}</b>playing</span>`);
    if (data.pausedCount) parts.push(`<span><b>${data.pausedCount}</b>paused</span>`);
    const transCount = (data.streams || []).filter((s) => s.isTranscoding).length;
    if (transCount) parts.push(`<span><b>${transCount}</b>transcoding</span>`);
    split.innerHTML = parts.join(' · ');
    split.style.display = parts.length ? 'flex' : 'none';

    const list = $('streams');
    list.innerHTML = '';

    if (!data.streams.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = data.online ? 'No active streams' : 'Waiting for connection…';
      list.appendChild(empty);
    } else {
      for (const s of data.streams) {
        const row = document.createElement('div');
        row.className = 'stream' + (s.isPaused ? ' paused' : ' playing');

        const poster = document.createElement('div');
        poster.className = 'poster';
        // posterDataUri omitted → we already cache this poster; '' → no art.
        let uri = s.posterDataUri;
        if (uri === undefined) uri = posterCache.get(s.posterKey) || '';
        else if (uri && s.posterKey) cachePoster(s.posterKey, uri);
        if (uri) {
          poster.style.backgroundImage = `url("${uri}")`;
          poster.classList.add('has-image');
        } else {
          // Use the title's first letters as the poster glyph when we have no art
          poster.textContent = initials(s.title || s.deviceName || '?');
        }
        // Equalizer overlay (visible when playing per CSS)
        const eq = document.createElement('div');
        eq.className = 'eq';
        eq.innerHTML = '<span></span><span></span><span></span>';
        poster.appendChild(eq);

        const meta = document.createElement('div');
        meta.className = 'stream-meta';

        const titleRow = document.createElement('div');
        titleRow.style.display = 'flex';
        titleRow.style.alignItems = 'center';
        titleRow.style.gap = '6px';

        // Avatar with user initials, stable colour
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = initials(s.userName);
        avatar.style.background = userColor(s.userName || s.deviceName || '');

        const title = document.createElement('div');
        title.className = 'stream-title';
        title.style.flex = '1';
        title.style.minWidth = '0';
        title.textContent = s.title || s.deviceName || 'Unknown';

        titleRow.appendChild(avatar);
        titleRow.appendChild(title);

        const sub = document.createElement('div');
        sub.className = 'stream-sub';
        const subParts = [];
        if (s.subtitle) subParts.push(s.subtitle);
        if (s.deviceName) subParts.push(s.deviceName);
        sub.textContent = subParts.join(' · ');

        const foot = document.createElement('div');
        foot.className = 'stream-foot';

        const badge = document.createElement('span');
        badge.className = 'badge' + (s.isPaused ? ' paused' : '');
        badge.textContent = s.isPaused ? 'paused' : 'playing';

        const transBadge = document.createElement('span');
        if (s.isTranscoding) {
          transBadge.className = 'badge transcoding';
          transBadge.textContent = 'TR';
          transBadge.title = 'Transcoding';
        }

        const progress = document.createElement('div');
        progress.className = 'progress';
        const bar = document.createElement('span');
        const pct = s.durationSeconds > 0
          ? Math.max(0, Math.min(100, (s.positionSeconds / s.durationSeconds) * 100))
          : 0;
        bar.style.width = pct + '%';
        progress.appendChild(bar);

        const time = document.createElement('span');
        time.textContent = s.durationSeconds > 0
          ? `${fmtTime(s.positionSeconds)} / ${fmtTime(s.durationSeconds)}`
          : fmtTime(s.positionSeconds);

        foot.appendChild(badge);
        if (s.isTranscoding) foot.appendChild(transBadge);
        foot.appendChild(progress);
        foot.appendChild(time);

        meta.appendChild(titleRow);
        meta.appendChild(sub);
        meta.appendChild(foot);

        row.appendChild(poster);
        row.appendChild(meta);
        list.appendChild(row);
      }
    }
  }

  function showError(msg) {
    $('server-name').textContent = 'Error';
    $('server-sub').textContent = msg;
    document.querySelector('.status .dot').classList.add('offline');
    $('status-text').textContent = 'error';
  }

  async function refresh() {
    // In-flight guard: a slow response must not stack overlapping polls.
    if (refreshing) return;
    refreshing = true;
    let retry = false;
    try {
      const have = Array.from(posterCache.keys()).join(',');
      const data = await Homey.api('GET', '/overview' + serverQuery({ have }));
      render(data);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (serverId && msg.indexOf('Unknown server') !== -1) {
        // Stored selection points at an unpaired server — fall back to default.
        serverId = null;
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* storage unavailable */ }
        posterCache.clear();
        retry = true;
      } else {
        showError(msg);
      }
    } finally {
      refreshing = false;
      if (!announcedReady) {
        announcedReady = true;
        Homey.ready();
      }
    }
    if (retry) refresh();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refresh, refreshSeconds * 1000);
  }
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // --- Server switcher (only visible with 2+ paired servers) ---
  const serverSelect = $('server-select');
  serverSelect.addEventListener('change', () => {
    serverId = serverSelect.value;
    try { localStorage.setItem(LS_KEY, serverId); } catch (e) { /* storage unavailable */ }
    posterCache.clear();
    refresh();
  });

  async function loadServers() {
    try {
      const servers = await Homey.api('GET', '/servers');
      if (!Array.isArray(servers) || servers.length <= 1) {
        serverSelect.classList.add('hidden');
        return;
      }
      if (!servers.some((s) => s.id === serverId)) serverId = servers[0].id;
      serverSelect.innerHTML = '';
      for (const s of servers) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        serverSelect.appendChild(opt);
      }
      serverSelect.value = serverId;
      serverSelect.classList.remove('hidden');
    } catch (e) { /* keep default server */ }
  }

  // Pause polling while the dashboard is hidden; resume with a fresh fetch.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      refresh();
    }
  });
  window.addEventListener('pagehide', () => stopPolling());

  loadServers();
  refresh();
  startPolling();
}

if (typeof Homey !== 'undefined') {
  Homey.ready ? onHomeyReady(Homey) : (window.onHomeyReady = onHomeyReady);
} else {
  window.onHomeyReady = onHomeyReady;
}
