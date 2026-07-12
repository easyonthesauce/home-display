// Dear Diary — a wake-word-activated video diary for the kitchen display.
//
// Say "Dear Diary" (configurable), confirm with "yes" (voice or a tap), watch
// a 5-second countdown, then talk to the webcam for up to a minute. The clip
// is uploaded to the server, which files it into Google Drive and updates a
// manifest — see watchtower/diary.js. Everything here runs in the browser;
// nothing is uploaded until the person explicitly finishes (or times out).
(() => {
  const $ = (id) => document.getElementById(id);

  let cfg = null;                 // { wakeWord, countdownSeconds, maxSeconds, suggestions }
  let entries = [];
  let driveConfigured = false;

  let recognition = null;
  let wakeArmed = false;          // is the wake-word listener turned on
  let mode = 'off';               // 'off' | 'wake' | 'confirm' — what a heard phrase means right now
  let busy = false;               // a ready-prompt/countdown/recording is already in flight

  let stream = null;
  let recorder = null;
  let chunks = [];
  let recordedAt = null;
  let elapsedSec = 0;
  let recordingStartedAt = 0;
  let timerInterval = null;

  // ---------- bootstrap ----------
  async function init() {
    let res;
    try {
      res = await fetch('/api/diary');
    } catch { return; }
    if (!res.ok) return;   // Dear Diary disabled → do nothing
    const data = await res.json();
    cfg = {
      wakeWord: (data.wakeWord || 'dear diary').toLowerCase(),
      countdownSeconds: data.countdownSeconds || 5,
      maxSeconds: data.maxSeconds || 60,
      suggestions: data.suggestions || [],
    };
    entries = data.entries || [];
    driveConfigured = Boolean(data.driveConfigured);
    renderEntries();
    if (!driveConfigured) {
      const hint = $('diary-hint');
      if (hint) hint.textContent = 'Google Drive isn’t configured yet, so entries are only kept on this device for now.';
    }

    $('diary-btn').hidden = false;
    $('diary-btn').addEventListener('click', toggleWakeWord);
    $('diary-ready-yes').addEventListener('click', confirmYes);
    $('diary-ready-no').addEventListener('click', declineReady);
    $('diary-stop-btn').addEventListener('click', stopRecording);
    $('diary-record-now').addEventListener('click', () => triggerReady());
  }

  // ---------- wake-word listening ----------
  function toggleWakeWord() {
    if (wakeArmed) { disableWakeWord(); return; }
    enableWakeWord();
  }

  function enableWakeWord() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      window.watchtowerFlash?.('voice activation isn’t supported in this browser — use "record an entry now" on the Dear Diary page instead');
      return;
    }
    wakeArmed = true;
    mode = 'wake';
    const btn = $('diary-btn');
    btn.querySelector('.label').textContent = `listening for "${cfg.wakeWord}"`;
    btn.classList.add('armed');

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = handleSpeechResult;
    recognition.onerror = () => { /* no-speech / aborted — onend restarts it */ };
    recognition.onend = () => { if (wakeArmed) setTimeout(() => { if (wakeArmed) { try { recognition.start(); } catch { /* already running */ } } }, 300); };
    try { recognition.start(); } catch { /* already running */ }
  }

  function disableWakeWord() {
    wakeArmed = false;
    mode = 'off';
    if (recognition) { try { recognition.stop(); } catch { /* ignore */ } }
    const btn = $('diary-btn');
    btn.querySelector('.label').textContent = 'enable dear diary';
    btn.classList.remove('armed');
  }

  function handleSpeechResult(event) {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.toLowerCase();
    if (mode === 'wake' && transcript.includes(cfg.wakeWord)) {
      triggerReady();
    } else if (mode === 'confirm' && /\b(yes|yeah|yep|ready)\b/.test(transcript)) {
      confirmYes();
    }
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* ignore */ }
  }

  // ---------- ready prompt ----------
  function triggerReady() {
    if (busy) return;
    busy = true;
    mode = 'confirm';
    $('diary-ready-overlay').hidden = false;
    speak('Dear Diary. Are you ready?');
  }

  function declineReady() {
    $('diary-ready-overlay').hidden = true;
    busy = false;
    mode = wakeArmed ? 'wake' : 'off';
  }

  function confirmYes() {
    if (mode !== 'confirm') return;
    mode = wakeArmed ? 'wake' : 'off';   // keep the wake word live, ignore stray "yes"es while recording
    $('diary-ready-overlay').hidden = true;
    startCountdown();
  }

  // ---------- countdown ----------
  const COUNTDOWN_COLORS = ['#f87171', '#fbbf24', '#22d3ee', '#34d399', '#a78bfa'];

  function startCountdown() {
    $('diary-record-overlay').hidden = false;
    const countdownEl = $('diary-countdown');
    const dot = $('diary-dot');
    const numberEl = $('diary-dot-number');
    countdownEl.hidden = false;

    let n = cfg.countdownSeconds || 5;
    (function tick() {
      if (n <= 0) { countdownEl.hidden = true; startRecording(); return; }
      numberEl.textContent = n;
      dot.style.background = COUNTDOWN_COLORS[n % COUNTDOWN_COLORS.length];
      n -= 1;
      setTimeout(tick, 1000);
    })();
  }

  // ---------- recording ----------
  function pickMimeType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }

  async function startRecording() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    } catch (e) {
      window.watchtowerFlash?.(`Dear Diary couldn’t access the camera/mic: ${e.message}`);
      $('diary-record-overlay').hidden = true;
      resetToIdle();
      return;
    }

    const preview = $('diary-preview');
    preview.srcObject = stream;
    renderSuggestions();
    $('diary-recording').hidden = false;

    recordedAt = new Date();
    chunks = [];
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finalizeRecording;
    recorder.start(1000);

    recordingStartedAt = Date.now();
    elapsedSec = 0;
    updateTimer();
    const maxSeconds = cfg.maxSeconds || 60;
    timerInterval = setInterval(() => {
      elapsedSec = Math.floor((Date.now() - recordingStartedAt) / 1000);
      updateTimer();
      if (elapsedSec >= maxSeconds) stopRecording();
    }, 250);
  }

  function updateTimer() {
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    $('diary-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderSuggestions() {
    const list = $('diary-suggestions-list');
    list.innerHTML = (cfg.suggestions || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  }

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    clearInterval(timerInterval);
    recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    $('diary-recording').hidden = true;
  }

  async function finalizeRecording() {
    const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'video/webm' });
    chunks = [];
    $('diary-saving').hidden = false;
    $('diary-saving-text').textContent = 'Saving your entry…';
    try {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const form = new FormData();
      form.append('video', blob, `entry.${ext}`);
      form.append('durationSec', String(elapsedSec));
      form.append('recordedAt', recordedAt.toISOString());
      const res = await fetch('/api/diary/upload', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `upload failed (${res.status})`);
      $('diary-saving-text').textContent = body.savedToDrive ? 'Saved to Google Drive ✓' : 'Saved locally (Drive not configured)';
      if (body.entry) { entries.unshift(body.entry); entries = entries.slice(0, 20); renderEntries(); }
      window.watchtowerFlash?.('📔 Dear Diary entry saved');
    } catch (e) {
      $('diary-saving-text').textContent = `Save failed: ${e.message}`;
      window.watchtowerFlash?.(`Dear Diary save failed: ${e.message}`);
    } finally {
      setTimeout(() => {
        $('diary-saving').hidden = true;
        $('diary-record-overlay').hidden = true;
        resetToIdle();
      }, 2200);
    }
  }

  function resetToIdle() {
    busy = false;
    mode = wakeArmed ? 'wake' : 'off';
  }

  // ---------- entries list ----------
  function renderEntries() {
    const list = $('diary-entries');
    if (!list) return;
    if (!entries.length) {
      list.innerHTML = '<li class="diary-entry diary-entry--empty">No entries yet — say "Dear Diary" to record the first one.</li>';
      return;
    }
    const tpl = $('diary-entry-tpl');
    list.innerHTML = '';
    for (const e of entries) {
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.querySelector('[data-f=date]').textContent = new Date(e.recordedAt).toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      el.querySelector('[data-f=dur]').textContent = e.durationSec ? `${e.durationSec}s` : '';
      const link = el.querySelector('[data-f=link]');
      if (e.driveLink) link.href = e.driveLink;
      else link.remove();
      list.appendChild(el);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  init();
})();
