// Face enrolment + recognition for the kitchen display's own webcam.
//
// Everything sensitive happens here in the browser: the face-api library and
// its model weights are loaded locally from the server (served out of
// node_modules), webcam frames are analysed on-device, and only 128-number
// face *descriptors* are ever sent to the server — and only for a person who
// has explicitly consented to enrol. Unknown faces are matched ephemerally to
// decide "known vs unknown" and are never stored or uploaded.
(() => {
  const $ = (id) => document.getElementById(id);

  let cfg = null;                 // { matchThreshold, enrollSamples, unknownDwellMs }
  let enrolled = [];              // [{ id, name, descriptors: [[...]] }]
  let faceapi = null;             // lazy-loaded library global
  let modelsLoaded = false;
  let video = null;
  let running = false;
  let loopTimer = null;

  // In-memory only: descriptors of people who declined enrolment this session,
  // so we don't nag them again after they've said no. Never persisted.
  const declined = [];
  let unknownSince = 0;
  let overlayOpen = false;
  let enrolling = false;
  let lastGreetAt = 0;

  // ---------- bootstrap ----------
  async function init() {
    let res;
    try {
      res = await fetch('/api/faces');
    } catch { return; }
    if (!res.ok) return;                       // faces disabled → do nothing
    const data = await res.json();
    cfg = {
      matchThreshold: data.matchThreshold ?? 0.5,
      enrollSamples: data.enrollSamples ?? 5,
      unknownDwellMs: data.unknownDwellMs ?? 4000,
    };
    enrolled = data.people || [];

    const btn = $('cam-btn');
    btn.hidden = false;
    $('faces-manage-btn').hidden = false;
    btn.addEventListener('click', toggleCamera);
    $('face-overlay-yes').addEventListener('click', startEnrollment);
    $('face-overlay-no').addEventListener('click', declineEnrollment);
    $('enroll-cancel').addEventListener('click', cancelEnrollment);
    $('enroll-save').addEventListener('click', saveEnrollment);
    $('faces-manage-btn').addEventListener('click', openManage);
    $('faces-close').addEventListener('click', () => { $('faces-modal').hidden = true; });
    updateManageCount();
  }

  async function refreshEnrolled() {
    try {
      const res = await fetch('/api/faces');
      if (res.ok) { enrolled = (await res.json()).people || []; updateManageCount(); }
    } catch { /* ignore */ }
  }

  function updateManageCount() {
    const el = $('faces-manage-btn');
    if (el) el.querySelector('.count').textContent = enrolled.length;
  }

  // ---------- library + camera lifecycle ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function ensureModels() {
    if (modelsLoaded) return;
    if (!window.faceapi) await loadScript('/vendor/face-api/dist/face-api.js');
    faceapi = window.faceapi;
    const url = '/vendor/face-api/model';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(url),
      faceapi.nets.faceLandmark68Net.loadFromUri(url),
      faceapi.nets.faceRecognitionNet.loadFromUri(url),
    ]);
    modelsLoaded = true;
  }

  async function toggleCamera() {
    if (running) return stopCamera();
    const btn = $('cam-btn');
    btn.disabled = true;
    btn.querySelector('.label').textContent = 'starting…';
    try {
      if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        throw new Error('camera needs HTTPS or localhost (see README)');
      }
      await ensureModels();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      video = $('face-video');
      video.srcObject = stream;
      await video.play();
      running = true;
      btn.classList.add('armed');
      btn.querySelector('.label').textContent = 'camera on';
      scheduleLoop();
    } catch (e) {
      btn.querySelector('.label').textContent = 'enable camera';
      window.watchtowerFlash?.(`camera failed: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function stopCamera() {
    running = false;
    clearTimeout(loopTimer);
    if (video && video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
    const btn = $('cam-btn');
    btn.classList.remove('armed');
    btn.querySelector('.label').textContent = 'enable camera';
  }

  function scheduleLoop() {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(async () => {
      if (running) { try { await tick(); } catch { /* keep going */ } }
      if (running) scheduleLoop();
    }, 700);
  }

  // ---------- detection + matching ----------
  async function detectDescriptor() {
    const result = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? result.descriptor : null;   // Float32Array(128) or null
  }

  function bestMatch(descriptor, people) {
    let best = null;
    for (const p of people) {
      for (const sample of p.descriptors) {
        const dist = faceapi.euclideanDistance(descriptor, sample);
        if (!best || dist < best.distance) best = { id: p.id, name: p.name, distance: dist };
      }
    }
    return best;
  }

  async function tick() {
    if (overlayOpen || enrolling) return;      // pause detection during a prompt
    const descriptor = await detectDescriptor();
    if (!descriptor) { unknownSince = 0; return; }

    const match = bestMatch(descriptor, enrolled);
    if (match && match.distance <= cfg.matchThreshold) {
      unknownSince = 0;
      greet(match.name);
      if (Date.now() - lastGreetAt > 60000) {
        lastGreetAt = Date.now();
        fetch('/api/faces/recognized', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: match.id, name: match.name }),
        }).catch(() => {});
      }
      return;
    }

    // Unknown. Skip if they already declined this session.
    const declinedMatch = bestMatch(descriptor, declined.map((d, i) => ({ id: `d${i}`, name: '', descriptors: [d] })));
    if (declinedMatch && declinedMatch.distance <= cfg.matchThreshold) { unknownSince = 0; return; }

    if (!unknownSince) unknownSince = Date.now();
    if (Date.now() - unknownSince >= cfg.unknownDwellMs) {
      lastUnknownDescriptor = Array.from(descriptor);
      showOverlay();
    }
  }

  let lastUnknownDescriptor = null;

  function greet(name) {
    const el = $('face-greet');
    el.textContent = `👋 Hi ${name}`;
    el.classList.add('show');
    clearTimeout(greet._t);
    greet._t = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // ---------- "have we met?" overlay ----------
  function showOverlay() {
    overlayOpen = true;
    $('face-overlay').hidden = false;
  }
  function hideOverlay() {
    overlayOpen = false;
    unknownSince = 0;
    $('face-overlay').hidden = true;
  }
  function declineEnrollment() {
    if (lastUnknownDescriptor) declined.push(lastUnknownDescriptor);   // remember "no" for this session only
    hideOverlay();
    window.watchtowerFlash?.('no problem — we won’t ask again this visit');
  }

  // ---------- enrolment flow (consent already given by clicking "yes") ----------
  const captured = [];
  let captureTimer = null;

  function startEnrollment() {
    $('face-overlay').hidden = true;
    overlayOpen = false;
    enrolling = true;
    captured.length = 0;
    $('enroll-modal').hidden = false;
    $('enroll-name').value = '';
    $('enroll-save').disabled = true;
    setEnrollStatus(`Look at the camera — capturing ${cfg.enrollSamples} samples…`);
    // mirror the live webcam into the modal preview
    const preview = $('enroll-preview');
    if (video && video.srcObject) { preview.srcObject = video.srcObject; preview.play().catch(() => {}); }
    captureLoop();
  }

  async function captureLoop() {
    clearTimeout(captureTimer);
    if (!enrolling) return;
    if (captured.length < cfg.enrollSamples) {
      try {
        const d = await detectDescriptor();
        if (d) {
          captured.push(Array.from(d));
          setEnrollStatus(`Captured ${captured.length} / ${cfg.enrollSamples}… hold still`);
        }
      } catch { /* keep trying */ }
      captureTimer = setTimeout(captureLoop, 500);
    } else {
      setEnrollStatus('Great — now, what’s your name?');
      $('enroll-name').focus();
      $('enroll-save').disabled = false;
    }
  }

  function setEnrollStatus(text) { $('enroll-status').textContent = text; }

  async function saveEnrollment() {
    const name = $('enroll-name').value.trim();
    if (!name) { setEnrollStatus('Please enter a name.'); return; }
    if (!captured.length) { setEnrollStatus('No samples captured — try again in better light.'); return; }
    $('enroll-save').disabled = true;
    setEnrollStatus('Saving…');
    try {
      const res = await fetch('/api/faces/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, descriptors: captured, consent: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) { setEnrollStatus(`Couldn’t save: ${body.error || res.status}`); $('enroll-save').disabled = false; return; }
      await refreshEnrolled();
      window.watchtowerFlash?.(`nice to meet you, ${name}!`);
      cancelEnrollment();
      greet(name);
    } catch (e) {
      setEnrollStatus(`Couldn’t save: ${e.message}`);
      $('enroll-save').disabled = false;
    }
  }

  function cancelEnrollment() {
    enrolling = false;
    clearTimeout(captureTimer);
    captured.length = 0;
    const preview = $('enroll-preview');
    if (preview) preview.srcObject = null;
    $('enroll-modal').hidden = true;
  }

  // ---------- manage / forget ----------
  async function openManage() {
    await refreshEnrolled();
    const listEl = $('faces-list');
    if (!enrolled.length) {
      listEl.innerHTML = '<li class="faces-empty">Nobody enrolled yet.</li>';
    } else {
      listEl.innerHTML = enrolled.map((p) => `
        <li>
          <span>${escapeHtml(p.name)} <small>${p.sampleCount || (p.descriptors ? p.descriptors.length : 0)} samples</small></span>
          <button class="faces-forget" data-id="${p.id}">forget</button>
        </li>`).join('');
      listEl.querySelectorAll('.faces-forget').forEach((b) => {
        b.addEventListener('click', () => forget(b.dataset.id));
      });
    }
    $('faces-modal').hidden = false;
  }

  async function forget(id) {
    try {
      await fetch(`/api/faces/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshEnrolled();
      openManage();
    } catch { /* ignore */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
