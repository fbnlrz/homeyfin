/* global Homey */

function onHomeyReady(Homey) {
  const settings = Homey.getSettings() || {};
  const refreshSeconds = Math.max(1, Math.min(30, Number(settings.refreshSeconds) || 2));

  const $ = (id) => document.getElementById(id);
  const root = $('root');

  let lastStream = null;
  let dragging = false;
  let localTick = null;

  function fmtTime(sec, sign = '') {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${sign}${m}:${String(s).padStart(2, '0')}`;
  }

  function setProgress(position, duration) {
    const pct = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
    $('progress-fill').style.width = pct + '%';
    $('progress-track').style.setProperty('--knob-x', pct + '%');
    $('time-now').textContent = fmtTime(position);
    $('time-rem').textContent = fmtTime(Math.max(0, duration - position), '-');
  }

  function render(data) {
    if (!data || !data.hasStream || !data.stream) {
      root.classList.add('empty');
      root.classList.remove('playing', 'paused', 'transcoding');
      $('empty-msg').textContent = data && data.server ? 'Nothing playing' : 'No server connected';
      lastStream = null;
      return;
    }
    root.classList.remove('empty');
    const s = data.stream;
    lastStream = s;

    root.classList.toggle('playing', !s.isPaused);
    root.classList.toggle('paused', s.isPaused);
    root.classList.toggle('transcoding', s.isTranscoding === true);

    $('title').textContent = s.title || s.deviceName || 'Unknown';
    $('sub').textContent = s.subtitle || '';
    const metaParts = [];
    if (s.userName) metaParts.push('@' + s.userName);
    if (s.deviceName) metaParts.push(s.deviceName);
    $('meta').textContent = metaParts.join(' · ');

    const poster = $('poster');
    if (s.posterUrl) {
      poster.style.backgroundImage = `url("${s.posterUrl}")`;
      poster.classList.add('has-image');
      $('backdrop').style.backgroundImage = `url("${s.posterUrl}")`;
    } else {
      poster.classList.remove('has-image');
    }

    if (!dragging) setProgress(s.positionSeconds, s.durationSeconds);

    $('btn-toggle').textContent = s.isPaused ? '▶' : '❚❚';
  }

  // Local 1Hz tick: between API refreshes, advance position smoothly.
  function startLocalTick() {
    if (localTick) return;
    localTick = setInterval(() => {
      if (!lastStream || lastStream.isPaused || dragging) return;
      lastStream.positionSeconds = Math.min(
        (lastStream.durationSeconds || Infinity),
        (lastStream.positionSeconds || 0) + 1,
      );
      setProgress(lastStream.positionSeconds, lastStream.durationSeconds);
    }, 1000);
  }

  async function refresh() {
    try {
      const data = await Homey.api('GET', '/now_playing');
      render(data);
    } catch (err) {
      root.classList.add('empty');
      $('empty-msg').textContent = err && err.message ? err.message : 'Error';
    } finally {
      Homey.ready();
    }
  }

  async function call(method, path, body) {
    try {
      await Homey.api(method, path, body || {});
      refresh();
    } catch (e) { /* ignore network blips, next refresh will repaint */ }
  }

  // --- Controls ---
  $('btn-toggle').addEventListener('click', () => call('POST', '/playback/toggle'));
  $('btn-back').addEventListener('click', () => call('POST', '/playback/skip', { seconds: -10 }));
  $('btn-fwd').addEventListener('click',  () => call('POST', '/playback/skip', { seconds:  10 }));
  $('btn-prev').addEventListener('click', () => call('POST', '/playback/chapter', { direction: 'prev' }));
  $('btn-next').addEventListener('click', () => call('POST', '/playback/chapter', { direction: 'next' }));
  $('btn-fav').addEventListener('click', async () => {
    try {
      const r = await Homey.api('POST', '/playback/favorite', {});
      $('btn-fav').classList.toggle('active', !!(r && r.favorite));
    } catch (e) { /* ignore */ }
  });
  $('btn-watched').addEventListener('click', () => call('POST', '/playback/watched'));

  // --- Scrubbable progress bar ---
  const track = $('progress-track');
  function posPctFromEvent(ev) {
    const rect = track.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }
  function previewSeek(ev) {
    if (!lastStream) return;
    const pct = posPctFromEvent(ev);
    const target = (lastStream.durationSeconds || 0) * pct;
    setProgress(target, lastStream.durationSeconds);
  }
  function commitSeek(ev) {
    if (!lastStream || !lastStream.durationSeconds) return;
    const pct = posPctFromEvent(ev);
    const target = Math.round(lastStream.durationSeconds * pct);
    lastStream.positionSeconds = target;
    call('POST', '/playback/seek', { seconds: target });
  }
  track.addEventListener('pointerdown', (ev) => {
    dragging = true;
    track.classList.add('dragging');
    track.setPointerCapture(ev.pointerId);
    previewSeek(ev);
  });
  track.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    previewSeek(ev);
  });
  track.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    commitSeek(ev);
  });
  track.addEventListener('pointercancel', () => {
    dragging = false;
    track.classList.remove('dragging');
  });

  startLocalTick();
  refresh();
  setInterval(refresh, refreshSeconds * 1000);
}

if (typeof Homey !== 'undefined') {
  Homey.ready ? onHomeyReady(Homey) : (window.onHomeyReady = onHomeyReady);
} else {
  window.onHomeyReady = onHomeyReady;
}
