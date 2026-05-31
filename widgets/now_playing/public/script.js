/* global Homey */

function onHomeyReady(Homey) {
  const settings = Homey.getSettings() || {};
  const refreshSeconds = Math.max(1, Math.min(30, Number(settings.refreshSeconds) || 3));

  const $ = (id) => document.getElementById(id);

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function render(data) {
    const root = $('root');
    if (!data || !data.hasStream || !data.stream) {
      root.classList.add('empty');
      $('empty-msg').textContent = data && data.server ? 'Nothing playing' : 'No server connected';
      return;
    }
    root.classList.remove('empty');

    const s = data.stream;
    $('title').textContent = s.title || s.deviceName || 'Unknown';
    $('sub').textContent = s.subtitle || '';
    const metaParts = [];
    if (s.userName) metaParts.push('@' + s.userName);
    if (s.deviceName) metaParts.push(s.deviceName);
    if (s.isPaused) metaParts.push('paused');
    $('meta').textContent = metaParts.join(' · ');

    if (s.posterUrl) $('poster').style.backgroundImage = `url("${s.posterUrl}")`;

    const pct = s.durationSeconds > 0
      ? Math.max(0, Math.min(100, (s.positionSeconds / s.durationSeconds) * 100))
      : 0;
    $('bar').style.width = pct + '%';
    $('time-now').textContent = fmtTime(s.positionSeconds);
    $('time-tot').textContent = fmtTime(s.durationSeconds);
    $('stream').style.display = 'flex';
  }

  async function refresh() {
    try {
      const data = await Homey.api('GET', '/now_playing');
      render(data);
    } catch (err) {
      const root = $('root');
      root.classList.add('empty');
      $('empty-msg').textContent = err && err.message ? err.message : 'Error';
    } finally {
      Homey.ready();
    }
  }

  $('toggle').addEventListener('click', async () => {
    try {
      await Homey.api('POST', '/playback/toggle', {});
      refresh();
    } catch (e) { /* ignore */ }
  });

  refresh();
  setInterval(refresh, refreshSeconds * 1000);
}

if (typeof Homey !== 'undefined') {
  Homey.ready ? onHomeyReady(Homey) : (window.onHomeyReady = onHomeyReady);
} else {
  window.onHomeyReady = onHomeyReady;
}
