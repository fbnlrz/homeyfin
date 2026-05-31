/* global Homey */

function onHomeyReady(Homey) {
  const settings = Homey.getSettings() || {};
  const refreshSeconds = Math.max(2, Math.min(60, Number(settings.refreshSeconds) || 5));

  const $ = (id) => document.getElementById(id);

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

    $('stat-active').textContent = fmtCount(data.activeCount + data.pausedCount);
    $('stat-movies').textContent = fmtCount(data.counts.movies);
    $('stat-series').textContent = fmtCount(data.counts.series);
    $('stat-episodes').textContent = fmtCount(data.counts.episodes);

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
        row.className = 'stream';

        const poster = document.createElement('div');
        poster.className = 'poster';
        if (s.posterUrl) poster.style.backgroundImage = `url("${s.posterUrl}")`;

        const meta = document.createElement('div');
        meta.className = 'stream-meta';

        const title = document.createElement('div');
        title.className = 'stream-title';
        title.textContent = s.title || s.deviceName || 'Unknown';

        const sub = document.createElement('div');
        sub.className = 'stream-sub';
        const subParts = [];
        if (s.subtitle) subParts.push(s.subtitle);
        if (s.userName) subParts.push('@' + s.userName);
        if (s.deviceName) subParts.push(s.deviceName);
        sub.textContent = subParts.join(' · ');

        const foot = document.createElement('div');
        foot.className = 'stream-foot';

        const badge = document.createElement('span');
        badge.className = 'badge' + (s.isPaused ? ' paused' : '');
        badge.textContent = s.isPaused ? 'paused' : 'playing';

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
        foot.appendChild(progress);
        foot.appendChild(time);

        meta.appendChild(title);
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
    try {
      const data = await Homey.api('GET', '/widget/overview');
      render(data);
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
    } finally {
      Homey.ready();
    }
  }

  refresh();
  setInterval(refresh, refreshSeconds * 1000);
}

if (typeof Homey !== 'undefined') {
  Homey.ready ? onHomeyReady(Homey) : (window.onHomeyReady = onHomeyReady);
} else {
  window.onHomeyReady = onHomeyReady;
}
