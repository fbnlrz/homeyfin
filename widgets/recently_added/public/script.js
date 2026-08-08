/* global Homey */

function onHomeyReady(Homey) {
  const settings = Homey.getSettings() || {};
  // Content changes rarely — keep the poll conservative (min 60 s).
  const refreshSeconds = Math.max(60, Math.min(3600, Number(settings.refreshSeconds) || 300));

  const $ = (id) => document.getElementById(id);

  const LS_KEY = 'homeyfin.recently_added.server';
  const lang = (navigator.language || 'en').slice(0, 2);
  const TEXTS = {
    tabLatest: { en: 'New', de: 'Neu', nl: 'Nieuw' },
    tabResume: { en: 'Continue', de: 'Weiterschauen', nl: 'Verder kijken' },
    noServer: { en: 'No server connected', de: 'Kein Server verbunden', nl: 'Geen server verbonden' },
    offline: { en: 'Server offline', de: 'Server offline', nl: 'Server offline' },
    emptyLatest: { en: 'No recently added items', de: 'Keine neuen Inhalte', nl: 'Geen nieuwe items' },
    emptyResume: { en: 'Nothing to continue watching', de: 'Nichts zum Weiterschauen', nl: 'Niets om verder te kijken' },
    noClients: { en: 'No active client found', de: 'Kein aktiver Client gefunden', nl: 'Geen actieve client gevonden' },
    playOn: { en: 'Play on…', de: 'Abspielen auf…', nl: 'Afspelen op…' },
    loading: { en: 'Loading…', de: 'Lade…', nl: 'Laden…' },
  };
  const t = (key) => TEXTS[key][lang] || TEXTS[key].en;

  let tab = 'latest';
  let pollTimer = null;
  let announcedReady = false;
  let serverId = null;
  try { serverId = localStorage.getItem(LS_KEY) || null; } catch (e) { /* storage unavailable */ }

  // Posters travel only once per item: the API skips the data URI for ids we
  // report as already cached. Small FIFO cap keeps webview memory bounded.
  const POSTER_CACHE_MAX = 40;
  const posterCache = new Map();
  function cachePoster(id, uri) {
    if (posterCache.has(id)) posterCache.delete(id);
    posterCache.set(id, uri);
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

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[parts.length - 1][0]);
  }

  function showEmpty(msg) {
    $('grid').classList.add('hidden');
    const el = $('empty-msg');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function render(data) {
    const grid = $('grid');
    if (!data || !data.server) return showEmpty(t('noServer'));
    const items = data.items || [];
    if (!items.length) {
      if (!data.online) return showEmpty(t('offline'));
      return showEmpty(tab === 'resume' ? t('emptyResume') : t('emptyLatest'));
    }

    $('empty-msg').classList.add('hidden');
    grid.classList.remove('hidden');
    grid.innerHTML = '';

    for (const item of items) {
      const tile = document.createElement('div');
      tile.className = 'tile';

      const poster = document.createElement('div');
      poster.className = 'poster';
      let uri = item.posterDataUri;
      if (uri) cachePoster(item.id, uri);
      else uri = posterCache.get(item.id) || '';
      if (uri) {
        poster.style.backgroundImage = `url("${uri}")`;
        poster.classList.add('has-image');
      } else {
        // Use the title's first letters as the poster glyph when we have no art
        const glyph = document.createElement('span');
        glyph.className = 'poster-glyph';
        glyph.textContent = initials(item.seriesName || item.name);
        poster.appendChild(glyph);
      }

      if (typeof item.progressPercent === 'number') {
        const progress = document.createElement('div');
        progress.className = 'tile-progress';
        const bar = document.createElement('span');
        bar.style.width = Math.max(0, Math.min(100, item.progressPercent)) + '%';
        progress.appendChild(bar);
        poster.appendChild(progress);
      }

      const title = document.createElement('div');
      title.className = 'tile-title';
      title.textContent = item.seriesName || item.name;

      const sub = document.createElement('div');
      sub.className = 'tile-sub';
      sub.textContent = item.seriesName ? item.name : '';

      tile.appendChild(poster);
      tile.appendChild(title);
      tile.appendChild(sub);
      tile.addEventListener('click', () => openSheet(item));
      grid.appendChild(tile);
    }
  }

  async function refresh() {
    try {
      const have = Array.from(posterCache.keys()).join(',');
      const data = await Homey.api('GET', '/items' + serverQuery({ tab, have }));
      render(data);
    } catch (err) {
      showEmpty(err && err.message ? err.message : 'Error');
    } finally {
      if (!announcedReady) {
        announcedReady = true;
        Homey.ready();
      }
    }
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

  // --- Tabs ---
  $('tab-latest').textContent = t('tabLatest');
  $('tab-resume').textContent = t('tabResume');
  function selectTab(next) {
    if (tab === next) return;
    tab = next;
    $('tab-latest').classList.toggle('active', tab === 'latest');
    $('tab-resume').classList.toggle('active', tab === 'resume');
    refresh();
  }
  $('tab-latest').addEventListener('click', () => selectTab('latest'));
  $('tab-resume').addEventListener('click', () => selectTab('resume'));

  // --- Session sheet (tap a poster → pick a client to play on) ---
  const sheet = $('sheet');
  function closeSheet() {
    sheet.classList.add('hidden');
    $('sheet-list').innerHTML = '';
  }
  $('sheet-backdrop').addEventListener('click', closeSheet);

  async function openSheet(item) {
    $('sheet-title').textContent = t('playOn');
    const list = $('sheet-list');
    list.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sheet-empty';
    loading.textContent = t('loading');
    list.appendChild(loading);
    sheet.classList.remove('hidden');

    let sessions = [];
    try {
      sessions = await Homey.api('GET', '/sessions' + serverQuery());
    } catch (e) { /* fall through to empty state */ }
    if (sheet.classList.contains('hidden')) return;

    list.innerHTML = '';
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = t('noClients');
      list.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const btn = document.createElement('button');
      btn.className = 'sheet-session';
      const name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = s.clientName || s.deviceId;
      const user = document.createElement('span');
      user.className = 'session-user';
      user.textContent = s.userName ? '@' + s.userName : '';
      btn.appendChild(name);
      btn.appendChild(user);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const body = { itemId: item.id, sessionId: s.sessionId };
          if (serverId) body.serverId = serverId;
          await Homey.api('POST', '/play', body);
          closeSheet();
        } catch (e) {
          btn.disabled = false;
        }
      });
      list.appendChild(btn);
    }
  }

  // --- Server switcher (only visible with 2+ paired servers) ---
  const serverSelect = $('server-select');
  serverSelect.addEventListener('change', () => {
    serverId = serverSelect.value;
    try { localStorage.setItem(LS_KEY, serverId); } catch (e) { /* storage unavailable */ }
    posterCache.clear();
    closeSheet();
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
