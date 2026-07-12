(() => {
  const $ = (id) => document.getElementById(id);
  const connDot = $('conn-dot');
  const statusText = $('status-text');
  const grid = $('camera-grid');
  const tpl = $('camera-tpl');
  const argPanel = $('arg-panel');
  const recBadge = $('rec-badge');

  const cams = new Map();       // cameraId -> card element
  const sceneTimes = new Map(); // cameraId -> at (for "ago")
  const lastScenes = new Map(); // cameraId -> latest scene
  const triggerBtns = new Map(); // cameraId -> button element
  const autoRows = new Map();    // cameraId -> { input, countdownEl }
  const autoState = new Map();   // cameraId -> { seconds, nextAt }
  let camerasRendered = false;
  let minAutoTriggerSeconds = 15;

  // ---------- manual + auto trigger bar ----------
  function renderTriggerBar(cameras) {
    if (camerasRendered || !cameras || !cameras.length) return;
    camerasRendered = true;
    const bar = $('trigger-bar');
    bar.innerHTML = '';
    for (const cam of cameras) {
      const row = document.createElement('div');
      row.className = 'trigger-row';

      const btn = document.createElement('button');
      btn.className = 'trigger-btn';
      btn.innerHTML = `<span class="dot"></span><span>trigger ${escapeHtml(cam.name)}</span>`;
      btn.addEventListener('click', () => fireTrigger(cam.id, btn));
      triggerBtns.set(cam.id, btn);

      const autoWrap = document.createElement('div');
      autoWrap.className = 'auto-wrap';
      autoWrap.innerHTML = `
        <span class="auto-label">auto every</span>
        <input type="number" class="auto-input" min="${minAutoTriggerSeconds}" step="5" placeholder="off" />
        <span class="auto-unit">s</span>
        <button class="auto-apply" type="button">set</button>
        <span class="auto-countdown">off</span>
      `;
      const input = autoWrap.querySelector('.auto-input');
      const applyBtn = autoWrap.querySelector('.auto-apply');
      applyBtn.addEventListener('click', () => setAutoTrigger(cam.id, input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') setAutoTrigger(cam.id, input.value); });
      autoRows.set(cam.id, { input, countdownEl: autoWrap.querySelector('.auto-countdown') });

      row.appendChild(btn);
      row.appendChild(autoWrap);
      bar.appendChild(row);
    }
  }

  async function fireTrigger(cameraId, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy');
    flashStatus(`triggering ${cameraId}…`);
    try {
      const res = await fetch(`/api/trigger/test?camera=${encodeURIComponent(cameraId)}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        flashStatus(`trigger failed: ${body.error || res.status}`);
      }
    } catch (e) {
      flashStatus(`trigger failed: ${e.message}`);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.classList.remove('busy'); }, 1500);
    }
  }

  async function setAutoTrigger(cameraId, rawSeconds) {
    const seconds = rawSeconds === '' ? 0 : Number(rawSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) { flashStatus('auto interval must be a number ≥ 0'); return; }
    try {
      const res = await fetch(`/api/trigger/auto?camera=${encodeURIComponent(cameraId)}&seconds=${seconds}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        flashStatus(`auto-trigger update failed: ${body.error || res.status}`);
        return;
      }
      flashStatus(body.seconds > 0 ? `auto-trigger for ${body.camera} set to every ${body.seconds}s` : `auto-trigger for ${body.camera} disabled`);
    } catch (e) {
      flashStatus(`auto-trigger update failed: ${e.message}`);
    }
  }

  function renderAutoTriggers(list) {
    if (!list) return;
    for (const entry of list) {
      autoState.set(entry.cameraId, entry);
      const row = autoRows.get(entry.cameraId);
      if (!row) continue;
      if (document.activeElement !== row.input) {
        row.input.value = entry.seconds > 0 ? entry.seconds : '';
      }
    }
    tickAutoCountdowns();
  }

  function tickAutoCountdowns() {
    for (const [cameraId, entry] of autoState) {
      const row = autoRows.get(cameraId);
      if (!row) continue;
      if (!entry.seconds || !entry.nextAt) {
        row.countdownEl.textContent = 'off';
        continue;
      }
      const remaining = Math.max(0, Math.round((entry.nextAt - Date.now()) / 1000));
      row.countdownEl.textContent = `next in ${remaining}s`;
    }
  }
  setInterval(tickAutoCountdowns, 1000);

  // ---------- gauges ----------
  function setGauge(fillEl, pct, dasharray) {
    const c = Math.max(0, Math.min(1, pct));
    fillEl.style.strokeDashoffset = String(dasharray * (1 - c));
  }

  // ---------- mess-o-meter (worst mess across cameras) ----------
  function renderMess(scenes) {
    const mess = scenes.reduce((m, s) => Math.max(m, s.mess_score || 0), 0);
    setGauge($('mess-fill'), mess / 10, 424);
    $('mess-value').textContent = mess;
  }

  // ---------- vibe sparkline ----------
  function renderVibe(vibe) {
    if (!vibe || !vibe.length) { $('vibe-score').textContent = '—'; return; }
    const last = vibe[vibe.length - 1];
    $('vibe-score').textContent = last.score;
    $('vibe-label').textContent = last.label || '';
    const n = vibe.length;
    const pts = vibe.map((v, i) => {
      const x = n > 1 ? (i / (n - 1)) * 600 : 0;
      const y = 120 - (v.score / 100) * 120;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    $('vibe-path').setAttribute('d', 'M' + pts.join(' L'));
  }

  // ---------- leaderboards ----------
  function renderBoard(id, rows, fmt) {
    const el = $(id);
    if (!rows || !rows.length) { el.innerHTML = '<li class="board__empty">nothing yet</li>'; return; }
    el.innerHTML = rows.map((r) => `<li>${escapeHtml(r.name)}<span>${fmt(r)}</span></li>`).join('');
  }
  function renderBoards(lb) {
    if (!lb) return;
    renderBoard('board-shame', lb.shame, (r) => `${r.offenses}×`);
    renderBoard('board-effort', lb.effort, (r) => `${r.avgEffort}`);
    renderBoard('board-recognition', lb.recognition, (r) => `${r.recognitions}×`);
  }

  // ---------- camera cards ----------
  function ensureCard(scene) {
    let el = cams.get(scene.cameraId);
    if (el) return el;
    el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = scene.cameraId;
    el.querySelector('.cam__name').textContent = scene.camera || scene.cameraId;
    grid.appendChild(el);
    cams.set(scene.cameraId, el);
    return el;
  }
  function renderScene(scene) {
    const el = ensureCard(scene);
    lastScenes.set(scene.cameraId, scene);
    sceneTimes.set(scene.cameraId, scene.at);
    el.querySelector('[data-f=count]').textContent = scene.people_count ?? 0;

    const people = el.querySelector('[data-f=people]');
    people.innerHTML = (scene.people || []).map((p) => {
      const name = /^unknown/i.test(p.identity) ? 'someone' : escapeHtml(p.identity);
      return `<span class="chip">${name}<small>${escapeHtml(p.doing || '')}</small><span class="eff">${p.effort}</span></span>`;
    }).join('') || '<span class="cam__doing">nobody in view</span>';

    el.querySelector('[data-f=activities]').textContent = (scene.activities || []).join(' · ');

    const notes = el.querySelector('[data-f=notes]');
    notes.innerHTML = (scene.notable_observations || []).map((n) => `<li>${escapeHtml(n)}</li>`).join('');

    const risks = el.querySelector('[data-f=risks]');
    risks.innerHTML = (scene.environment_risks || []).map((r) =>
      `<span class="risk ${r.severity}">${escapeHtml(r.risk)}</span>`).join('');

    const cw = scene.child_wellbeing || { risk_level: 'none' };
    const child = el.querySelector('[data-f=child]');
    child.className = `badge ${cw.risk_level}`;
    child.textContent = cw.risk_level === 'none' ? 'kids: ok' : `kids: ${cw.risk_level}${cw.notes ? ' — ' + cw.notes : ''}`;
  }

  function tickAges() {
    for (const [id, el] of cams) {
      const at = sceneTimes.get(id);
      if (!at) continue;
      const s = Math.round((Date.now() - at) / 1000);
      el.querySelector('[data-f=ago]').textContent = s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
    }
  }
  setInterval(tickAges, 1000);

  // ---------- argument overlay ----------
  function showArg(show) { argPanel.hidden = !show; recBadge.hidden = !show; }
  function renderAudio(p) {
    setGauge($('arg-fill'), p.escalation / 100, 462);
    $('arg-value').textContent = p.escalation;
    $('arg-tone').textContent = p.tone || '—';
    $('arg-trend').textContent = ({ escalating: '▲ escalating', 'de-escalating': '▼ calming', stable: '― steady' })[p.trend] || '';
    $('arg-noise').textContent = `noise ${Math.round(p.noise || 0)}`;
    $('arg-summary').textContent = p.summary || '';
    $('arg-transcript').textContent = (p.transcriptTail || []).join('  ·  ');

    const worm = p.worm || [];
    const n = worm.length;
    const pts = worm.map((w, i) => {
      const x = n > 1 ? (i / (n - 1)) * 600 : 0;
      const y = 120 - (w.escalation / 100) * 120;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    $('worm-path').setAttribute('d', n ? 'M' + pts.join(' L') : '');
    $('worm-safe').setAttribute('d', 'M0,72 L600,72 L600,120 L0,120 Z');  // calm band (<40)
  }

  // ---------- websocket ----------
  let lastMsgAt = 0, ws;
  function applyState(s) {
    if (s.minAutoTriggerSeconds) minAutoTriggerSeconds = s.minAutoTriggerSeconds;
    if (s.cameras) renderTriggerBar(s.cameras);
    if (s.autoTriggers) renderAutoTriggers(s.autoTriggers);
    if (s.scenes) s.scenes.forEach(renderScene);
    if (s.scenes) renderMess(s.scenes);
    if (s.store) { renderVibe(s.store.vibe); renderBoards(s.store.leaderboards); }
    showArg(Boolean(s.audioActive));
    if (s.alexa) renderAlexaBadge(s.alexa);
    statusText.textContent = s.hasApiKey ? 'live' : 'live (mock analysis — no API key)';
  }
  // Other page scripts (water.js) can subscribe to the shared WS stream.
  const subscribers = [];
  window.watchtowerSubscribe = (fn) => subscribers.push(fn);

  function handle(msg) {
    for (const fn of subscribers) { try { fn(msg); } catch { /* ignore */ } }
    switch (msg.type) {
      case 'hello': applyState(msg.payload); break;
      case 'scene.update':
        renderScene(msg.payload);
        renderMess(Array.from(lastScenes.values()));
        break;
      case 'audio.start':
        showArg(true);
        window.watchtowerShowPage?.('watch');   // surface raised voices whatever page is up
        break;
      case 'audio.update': showArg(true); renderAudio(msg.payload); break;
      case 'audio.end': showArg(false); break;
      case 'incident.recorded': flashStatus(`argument logged (peak ${msg.payload.peak})`); break;
      case 'alert.child': flashStatus(`⚠ child wellbeing: ${msg.payload.risk_level} on ${msg.payload.camera}`); break;
      case 'auto.updated': renderAutoTriggers(msg.payload.list); break;
      case 'trigger':
        if (msg.payload.source === 'auto') flashStatus(`auto-trigger fired: ${msg.payload.camera}`);
        break;
      case 'alexa.status': renderAlexaBadge({ enabled: true, status: msg.payload.status }); break;
      case 'alexa.announced': flashStatus(`🔊 Alexa: "${msg.payload.message}" → ${msg.payload.device}`); break;
      case 'alexa.error': flashStatus(`🔇 Alexa announcement failed: ${msg.payload.error}`); break;
      case 'face.enrolled': flashStatus(`👤 enrolled ${msg.payload.name}`); break;
      case 'face.forgotten': flashStatus('👤 a face was forgotten'); break;
    }
  }

  // ---------- Alexa badge ----------
  const alexaBadge = $('alexa-badge');
  const alexaDot = $('alexa-dot');
  function renderAlexaBadge(info) {
    if (!info || !info.enabled) { alexaBadge.hidden = true; return; }
    alexaBadge.hidden = false;
    alexaDot.className = `dot ${info.status || 'unknown'}`;
    alexaBadge.title = `Alexa Bridge: ${info.status || 'unknown'} — click to send a test announcement`;
  }
  alexaBadge.addEventListener('click', async () => {
    alexaBadge.disabled = true;
    flashStatus('sending test Alexa announcement…');
    try {
      const res = await fetch('/api/alexa/test', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) flashStatus(`Alexa test failed: ${body.error || res.status}`);
    } catch (e) {
      flashStatus(`Alexa test failed: ${e.message}`);
    } finally {
      setTimeout(() => { alexaBadge.disabled = false; }, 1500);
    }
  });
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    connDot.className = 'dot';
    statusText.textContent = 'connecting…';
    ws.onopen = () => { connDot.className = 'dot live'; };
    ws.onmessage = (e) => { lastMsgAt = Date.now(); try { handle(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { connDot.className = 'dot down'; statusText.textContent = 'reconnecting…'; setTimeout(connect, 1500); };
    ws.onerror = () => ws.close();
  }
  connect();

  let flashTimer;
  function flashStatus(text) {
    statusText.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { statusText.textContent = 'live'; }, 6000);
  }
  // Let faces.js (a separate script) surface status toasts through the same line.
  window.watchtowerFlash = flashStatus;

  // ---------- microphone loud-noise detection ----------
  // The kitchen display's own mic is a cheap always-on trigger. Crossing the loud
  // threshold tells the server to start pulling + analysing the camera's audio.
  const LOUD_ON = 62, QUIET = 30, QUIET_HOLD_MS = 6000;
  let eventActive = false, quietMs = 0, lastLevelPost = 0, smooth = 0;

  async function post(path, body) {
    try { await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
    catch {}
  }

  async function enableMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const btn = $('mic-btn');
      btn.textContent = '🎙 listening';
      btn.classList.add('armed');

      setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);            // 0..1
        const level = Math.min(100, Math.round(rms * 320)); // scaled to a 0-100 "loudness"
        smooth = smooth * 0.7 + level * 0.3;
        const now = Date.now();

        if (!eventActive && smooth >= LOUD_ON) {
          eventActive = true; quietMs = 0;
          post('/api/audio/loud', { level: Math.round(smooth) });
        } else if (eventActive) {
          if (now - lastLevelPost > 1000) { lastLevelPost = now; post('/api/audio/level', { level: Math.round(smooth) }); }
          quietMs = smooth < QUIET ? quietMs + 250 : 0;
          if (quietMs >= QUIET_HOLD_MS) { eventActive = false; quietMs = 0; post('/api/audio/quiet'); }
        }
      }, 250);
    } catch (e) {
      $('mic-btn').textContent = '🎙 mic blocked';
      flashStatus('microphone permission denied');
    }
  }
  $('mic-btn').addEventListener('click', enableMic);

  // ---------- chrome: clock + fullscreen ----------
  function clock() { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  clock(); setInterval(clock, 15000);
  $('fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') $('fullscreen-btn').click(); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
