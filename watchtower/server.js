require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { createLogger } = require('./logger');
const { createSmtpTrigger } = require('./smtp-trigger');
const { createEventBus } = require('./events');
const { createStore } = require('./state');
const { captureFrames, captureAudio, maskRtsp } = require('./capture');
const { analyzeScene } = require('./analysis/vision');
const { classifyEscalation } = require('./analysis/escalation');
const { transcribe } = require('./analysis/transcribe');
const { createAudioAnalyzer } = require('./analysis/audio');
const { createAutoTriggerScheduler } = require('./auto-trigger');
const { createAlexaClient } = require('./alexa');
const { createAlertRouter } = require('./alerts');
const { createFaceStore } = require('./faces');
const { createWaterStore } = require('./water');
const { createEsp32Client } = require('./esp32');
const { createPourManager } = require('./water-pour');

const log = createLogger('server');

const bus = createEventBus({ webhooks: config.webhooks, log: createLogger('events') });
const store = createStore({ file: config.statePath });
const faceStore = createFaceStore({ file: config.facesPath });
const faceLog = createLogger('faces');

// Water challenge: participant/consumption store + ESP32 dispenser + pour mgr.
const waterStore = createWaterStore({ file: config.waterPath, dailyGoalMl: config.water.dailyGoalMl });
const esp32 = createEsp32Client({ url: config.water.esp32Url, timeoutMs: config.water.esp32TimeoutMs });
const pourManager = createPourManager({ config, store: waterStore, esp32, emit: bus.emit });

// De-dupe recognition/greeting events so we don't spam the bus every frame the
// same person is on camera. Keyed by person id -> last-emitted timestamp.
const lastRecognized = new Map();
const RECOGNITION_COOLDOWN_MS = 60000;

// Alexa Bridge integration: a thin client to the sidecar service, plus the
// alert-rule router that watches every bus event and fires announcements
// for the ones matching a configured rule. See watchtower/alerts.js and
// alerts.json.example for the rule format.
const alexaClient = createAlexaClient(config.alexa);
const alertRouter = createAlertRouter({ config, bus, alexaClient });

let alexaStatus = { status: 'unknown' };
let alexaStatusTimer = null;
async function refreshAlexaStatus() {
  const previous = alexaStatus.status;
  alexaStatus = await alexaClient.status();
  if (alexaStatus.status !== previous) {
    log.info(`Alexa Bridge status changed: ${previous} → ${alexaStatus.status}`);
    bus.emit('alexa.status', alexaStatus);
  }
}
if (config.alerts.enabled && config.alerts.rules.length) {
  refreshAlexaStatus();
  alexaStatusTimer = setInterval(refreshAlexaStatus, 30000);
  alexaStatusTimer.unref();
}

// Most-recent scene per camera, so newly-connected dashboards and the /api/state
// endpoint can render immediately without waiting for the next motion trigger.
const latestScenes = new Map();

// Latest loudness (0-100) reported by the kitchen display's microphone. Feeds the
// noise gauge and acts as the escalation fallback when no transcriber is set up.
let latestNoise = 0;

const audio = createAudioAnalyzer({
  config,
  captureAudio,
  transcribe,
  classifyEscalation,
  emit: bus.emit,
  getNoiseLevel: () => latestNoise,
});

function resolveCamera(trigger) {
  const hay = [...(trigger.to || []), trigger.subject, trigger.from]
    .filter(Boolean).join(' ').toLowerCase();
  const matched = config.cameras.find((c) => c.trigger && hay.includes(c.trigger));
  if (matched) {
    log.debug(`resolved camera "${matched.id}" from trigger keyword "${matched.trigger}" (haystack: "${hay}")`);
  } else if (config.cameras[0]) {
    log.debug(`no keyword match in "${hay}" — falling back to first configured camera "${config.cameras[0].id}"`);
  }
  return matched || config.cameras[0] || null;
}

// A motion trigger arrived (from the fake SMTP server or the manual test route):
// grab frames, analyse, remember, and broadcast the scene.
const analyzing = new Set();
async function handleTrigger(trigger, source) {
  const camera = resolveCamera(trigger);
  if (!camera) { log.warn(`trigger from ${source} ignored — no cameras configured`); return; }

  if (analyzing.has(camera.id)) {
    log.info(`trigger for "${camera.name}" (source=${source}) debounced — analysis already in progress`);
    return;
  }
  analyzing.add(camera.id);
  const startedAt = Date.now();
  log.info(`trigger received: camera="${camera.name}" source=${source} subject="${trigger.subject || ''}"`);

  bus.emit('trigger', { camera: camera.name, cameraId: camera.id, source, subject: trigger.subject });
  try {
    let frames = [];
    const captureStart = Date.now();
    try {
      log.debug(`capturing ${config.frameCount} frames over ${config.clipSeconds}s from "${camera.name}" (${maskRtsp(camera.rtsp)})`);
      frames = await captureFrames(camera.rtsp, {
        seconds: config.clipSeconds, count: config.frameCount, ffmpeg: config.ffmpeg,
      });
      log.info(`captured ${frames.length} frame(s) from "${camera.name}" in ${Date.now() - captureStart}ms`);
    } catch (e) {
      log.error(`capture failed for "${camera.name}" after ${Date.now() - captureStart}ms: ${e.message}`);
      bus.emit('capture.error', { camera: camera.name, message: e.message });
    }

    const analysisStart = Date.now();
    const scene = await analyzeScene(camera, frames);
    log.info(
      `scene analysed for "${camera.name}" in ${Date.now() - analysisStart}ms: `
      + `people=${scene.people_count} mess=${scene.mess_score}/10 vibe=${scene.vibe.score} `
      + `child_risk=${scene.child_wellbeing.risk_level} hazards=${scene.environment_risks.length}`,
    );
    latestScenes.set(camera.id, scene);
    store.applyScene(scene);
    bus.emit('scene.update', scene);

    if (['elevated', 'high'].includes(scene.child_wellbeing.risk_level)) {
      log.warn(`child-wellbeing alert on "${camera.name}": ${scene.child_wellbeing.risk_level} — ${scene.child_wellbeing.notes}`);
      bus.emit('alert.child', { camera: camera.name, ...scene.child_wellbeing });
    }
    const highRisks = scene.environment_risks.filter((r) => r.severity === 'high');
    if (highRisks.length) {
      log.warn(`hazard alert on "${camera.name}": ${highRisks.map((r) => r.risk).join(', ')}`);
      bus.emit('alert.hazard', { camera: camera.name, risks: highRisks });
    }
  } catch (e) {
    log.error(`trigger handling failed for "${camera.name}": ${e.message}`);
  } finally {
    analyzing.delete(camera.id);
    log.debug(`trigger for "${camera.name}" completed in ${Date.now() - startedAt}ms total`);
  }
}

// Periodic "auto" triggers, independent of motion/SMTP. Each camera gets its
// own interval, set at startup from config and adjustable at runtime via
// POST /api/trigger/auto (e.g. from the dashboard's per-camera control).
const autoScheduler = createAutoTriggerScheduler({
  cameras: config.cameras,
  minSeconds: config.minAutoTriggerSeconds,
  fire: (cameraId) => {
    const cam = config.cameras.find((c) => c.id === cameraId);
    if (!cam) return;
    handleTrigger({ to: [cam.trigger], subject: 'auto trigger', from: 'scheduler' }, 'auto');
  },
});

// When a raised-voices event ends, the people identifiable in the last scene of
// the audio camera become the "offenders" for the name-and-shame board.
bus.on('audio.end', (payload) => {
  if (!payload || payload.peak < 55) {
    log.debug(`audio event ended below the incident threshold (peak=${payload && payload.peak}) — not recorded`);
    return;
  }
  const scene = latestScenes.get(config.audioCameraId);
  const offenders = scene ? scene.people
    .filter((p) => p.identity && !/^unknown/i.test(p.identity))
    .map((p) => p.identity) : [];
  const incident = { peak: payload.peak, offenders, recognized: [] };
  log.info(`incident recorded: peak=${payload.peak} offenders=[${offenders.join(', ')}]`);
  store.applyIncident(incident);
  bus.emit('incident.recorded', incident);
});

// ---- HTTP + WebSocket ----
const app = express();
app.use(express.json({ limit: '2mb' }));   // face descriptors are small but batched
app.use((req, _res, next) => {
  log.debug(`${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Serve the face-api browser library + model weights straight from the
// installed package, so the dashboard can do all detection/embedding locally
// (offline-capable, no CDN). No biometric data is involved here — just the
// static ML model files.
if (config.faces.enabled) {
  try {
    const faceApiDir = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
    app.use('/vendor/face-api/dist', express.static(path.join(faceApiDir, 'dist')));
    app.use('/vendor/face-api/model', express.static(path.join(faceApiDir, 'model')));
    log.info('face recognition enabled — serving face-api library + models from node_modules');
  } catch (e) {
    log.error(`FACES_ENABLED but @vladmandic/face-api is not installed: ${e.message}`);
  }
}

app.get('/api/state', (_req, res) => {
  res.json({
    cameras: config.cameras.map((c) => ({ id: c.id, name: c.name, audio: c.audio })),
    scenes: Array.from(latestScenes.values()),
    store: store.snapshot(),
    audioActive: audio.isActive(),
    noise: latestNoise,
    autoTriggers: autoScheduler.list(),
    minAutoTriggerSeconds: config.minAutoTriggerSeconds,
    hasApiKey: config.hasApiKey,
    hasTranscriber: Boolean(config.transcribeCmd),
    llm: {
      provider: config.llm.provider,
      visionModel: config.models.vision,
      escalationModel: config.models.escalation,
      available: config.hasApiKey,
    },
    alexa: {
      enabled: config.alerts.enabled && alertRouter.rules.length > 0,
      status: alexaStatus.status,
      ruleCount: alertRouter.rules.length,
    },
    faces: {
      enabled: config.faces.enabled,
      matchThreshold: config.faces.matchThreshold,
      enrollSamples: config.faces.enrollSamples,
      unknownDwellMs: config.faces.unknownDwellMs,
      enrolledCount: faceStore.count(),
    },
    water: {
      enabled: config.water.enabled,
      participants: waterStore.count(),
      hardware: esp32.configured,
    },
    at: Date.now(),
  });
});

// The kitchen display's mic crossed the loud threshold — start listening.
app.post('/api/audio/loud', (req, res) => {
  latestNoise = Number(req.body && req.body.level) || latestNoise;
  log.info(`loud-noise trigger from browser: level=${latestNoise}`);
  const started = audio.start('browser-loud');
  if (!started) log.debug('audio session already active — ignoring duplicate loud trigger');
  res.json({ started, active: audio.isActive() });
});

// Continuous loudness updates while an event is in progress.
app.post('/api/audio/level', (req, res) => {
  latestNoise = Math.max(0, Math.min(100, Number(req.body && req.body.level) || 0));
  log.debug(`noise level update: ${latestNoise}`);
  res.json({ ok: true });
});

// Sustained quiet from the display — wind the session down.
app.post('/api/audio/quiet', (_req, res) => {
  log.info('sustained quiet reported by browser — stopping audio session');
  audio.stop();
  latestNoise = 0;
  res.json({ ok: true });
});

// Manually fire a motion trigger (for testing without an NVR, or via the
// dashboard's per-camera "trigger" button).
app.post('/api/trigger/test', (req, res) => {
  const cameraId = req.query.camera || (req.body && req.body.camera);
  if (!config.cameras.length) {
    log.warn('manual trigger requested but no cameras are configured');
    return res.status(503).json({ ok: false, error: 'no cameras configured' });
  }
  const cam = config.cameras.find((c) => c.id === cameraId);
  if (cameraId && !cam) {
    log.warn(`manual trigger requested unknown camera id "${cameraId}"`);
    return res.status(404).json({ ok: false, error: `unknown camera "${cameraId}"` });
  }
  const target = cam || config.cameras[0];
  log.info(`manual trigger fired for "${target.name}" (requested id: ${cameraId || '(default)'})`);
  handleTrigger({ to: target ? [target.trigger] : [], subject: 'manual test', from: 'test' }, 'manual');
  res.json({ ok: true, camera: target && target.name });
});

// Set (or disable, with seconds <= 0) a camera's periodic auto-trigger
// interval at runtime — e.g. from the dashboard's per-camera control.
app.post('/api/trigger/auto', (req, res) => {
  const cameraId = req.query.camera || (req.body && req.body.camera);
  const requestedSeconds = Number(req.query.seconds ?? (req.body && req.body.seconds));
  if (!config.cameras.length) {
    log.warn('auto-trigger update requested but no cameras are configured');
    return res.status(503).json({ ok: false, error: 'no cameras configured' });
  }
  const cam = config.cameras.find((c) => c.id === cameraId);
  if (!cam) {
    log.warn(`auto-trigger update requested unknown camera id "${cameraId}"`);
    return res.status(404).json({ ok: false, error: `unknown camera "${cameraId}"` });
  }
  if (!Number.isFinite(requestedSeconds)) {
    return res.status(400).json({ ok: false, error: 'seconds must be a number (0 to disable)' });
  }
  const effective = autoScheduler.set(cam.id, requestedSeconds);
  const entry = autoScheduler.get(cam.id);
  bus.emit('auto.updated', { list: autoScheduler.list() });
  res.json({ ok: true, camera: cam.name, seconds: effective, nextAt: entry.nextAt });
});

// Send a one-off test announcement through the Alexa Bridge, bypassing the
// alert rules entirely — for confirming the bridge is reachable and a
// device name is spelled correctly before wiring up real rules.
app.post('/api/alexa/test', async (req, res) => {
  const message = (req.body && req.body.message) || 'This is a test announcement from Watchtower.';
  const device = (req.body && req.body.device) || config.alerts.device;
  log.info(`manual Alexa test: device="${device}" message="${message}"`);
  try {
    const result = await alexaClient.announce(message, device);
    res.json({ ok: true, device, ...result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ── Face enrolment + recognition ────────────────────────────────────────────
// All detection/embedding happens in the browser on the display's webcam; the
// server only stores consented signatures and relays recognition events.
function facesGuard(_req, res, next) {
  if (!config.faces.enabled) return res.status(404).json({ ok: false, error: 'face recognition is disabled (set FACES_ENABLED=1)' });
  next();
}

// List enrolled people (includes descriptors so the dashboard can match locally).
app.get('/api/faces', facesGuard, (_req, res) => {
  res.json({
    enabled: true,
    matchThreshold: config.faces.matchThreshold,
    enrollSamples: config.faces.enrollSamples,
    unknownDwellMs: config.faces.unknownDwellMs,
    people: faceStore.list(),
  });
});

// Enrol a new person. Requires an explicit consent flag — the dashboard only
// sends this after the person agrees on the "have we met?" consent screen.
app.post('/api/faces/enroll', facesGuard, (req, res) => {
  const { name, descriptors, consent } = req.body || {};
  if (consent !== true) {
    return res.status(400).json({ ok: false, error: 'consent (boolean true) is required to enrol a face' });
  }
  try {
    const person = faceStore.enroll({ name, descriptors, consent });
    bus.emit('face.enrolled', { id: person.id, name: person.name, samples: person.sampleCount });
    res.json({ ok: true, person });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Add more samples to an existing person (improves accuracy over time).
app.post('/api/faces/:id/samples', facesGuard, (req, res) => {
  try {
    const person = faceStore.addSamples(req.params.id, (req.body || {}).descriptors);
    res.json({ ok: true, person });
  } catch (e) {
    res.status(e.message.includes('unknown') ? 404 : 400).json({ ok: false, error: e.message });
  }
});

// Forget a person — deletes their stored signature entirely.
app.delete('/api/faces/:id', facesGuard, (req, res) => {
  const ok = faceStore.forget(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  bus.emit('face.forgotten', { id: req.params.id });
  res.json({ ok: true });
});

// The dashboard reports a recognised face here so the server can relay it (for
// greetings, Alexa "welcome home" rules, webhooks), de-duped per person.
app.post('/api/faces/recognized', facesGuard, (req, res) => {
  const { id, name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  const key = id || name;
  const now = Date.now();
  const last = lastRecognized.get(key) || 0;
  if (now - last > RECOGNITION_COOLDOWN_MS) {
    lastRecognized.set(key, now);
    faceLog.info(`recognised "${name}" at the display`);
    bus.emit('face.recognized', { id, name });
    return res.json({ ok: true, emitted: true });
  }
  res.json({ ok: true, emitted: false });
});

// ── Water challenge ─────────────────────────────────────────────────────────
function waterGuard(_req, res, next) {
  if (!config.water.enabled) return res.status(404).json({ ok: false, error: 'the water challenge is disabled (set WATER_ENABLED=1)' });
  next();
}

// Computed view for a period, plus the active pour session + hardware state.
app.get('/api/water', waterGuard, (req, res) => {
  const view = waterStore.view(req.query.period);
  res.json({
    enabled: true,
    ...view,
    session: pourManager.snapshot(),
    maxPourMl: config.water.maxPourMl,
    hardware: { configured: esp32.configured },
  });
});

// Join the challenge / re-opt-in by name.
app.post('/api/water/participants', waterGuard, (req, res) => {
  try {
    const p = waterStore.addParticipant((req.body || {}).name);
    bus.emit('water.changed', { reason: 'participant-added', id: p.id, name: p.name });
    res.json({ ok: true, participant: p });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Opt a participant in/out.
app.post('/api/water/participants/:id/opt', waterGuard, (req, res) => {
  try {
    const p = waterStore.setOptIn(req.params.id, (req.body || {}).optedIn !== false);
    bus.emit('water.changed', { reason: 'opt-changed', id: p.id });
    res.json({ ok: true, participant: p });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message });
  }
});

app.delete('/api/water/participants/:id', waterGuard, (req, res) => {
  const ok = waterStore.removeParticipant(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  bus.emit('water.changed', { reason: 'participant-removed', id: req.params.id });
  res.json({ ok: true });
});

// Press "Drink": start a pour for the active drinker.
app.post('/api/water/pour/start', waterGuard, async (req, res) => {
  const userId = (req.body || {}).userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId is required (tap your lane first)' });
  try {
    const session = await pourManager.start(userId);
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Press "Drink" again (or explicit stop): finish the pour and record it.
app.post('/api/water/pour/stop', waterGuard, async (req, res) => {
  const result = await pourManager.stop('user');
  if (!result) return res.status(409).json({ ok: false, error: 'no pour in progress' });
  res.json({ ok: true, ...result });   // water.dispensed -> water.changed is emitted by the pour manager
});

// The ESP32 reports cumulative flow (ml) for the active pour session.
app.post('/api/water/flow', waterGuard, (req, res) => {
  const { ml, sessionId } = req.body || {};
  res.json(pourManager.reportFlow(ml, sessionId));
});

// When a pour finishes, tell every dashboard to refresh its water view.
bus.on('water.dispensed', () => bus.emit('water.changed', { reason: 'dispensed' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  bus.addClient(ws);
  log.info(`dashboard connected from ${req.socket.remoteAddress} (${bus.clientCount()} total)`);
  ws.send(JSON.stringify({
    type: 'hello',
    payload: {
      cameras: config.cameras.map((c) => ({ id: c.id, name: c.name, audio: c.audio })),
      scenes: Array.from(latestScenes.values()),
      store: store.snapshot(),
      audioActive: audio.isActive(),
      autoTriggers: autoScheduler.list(),
      minAutoTriggerSeconds: config.minAutoTriggerSeconds,
      hasApiKey: config.hasApiKey,
      hasTranscriber: Boolean(config.transcribeCmd),
      llm: {
        provider: config.llm.provider,
        visionModel: config.models.vision,
        escalationModel: config.models.escalation,
        available: config.hasApiKey,
      },
      alexa: {
        enabled: config.alerts.enabled && alertRouter.rules.length > 0,
        status: alexaStatus.status,
        ruleCount: alertRouter.rules.length,
      },
      faces: {
        enabled: config.faces.enabled,
        matchThreshold: config.faces.matchThreshold,
        enrollSamples: config.faces.enrollSamples,
        unknownDwellMs: config.faces.unknownDwellMs,
        enrolledCount: faceStore.count(),
      },
      water: {
        enabled: config.water.enabled,
        participants: waterStore.count(),
        hardware: esp32.configured,
      },
    },
    at: Date.now(),
  }));
  ws.on('close', () => {
    bus.removeClient(ws);
    log.info(`dashboard disconnected (${bus.clientCount()} remaining)`);
  });
  ws.on('error', (err) => {
    bus.removeClient(ws);
    log.warn(`dashboard connection error: ${err.message}`);
  });
});

// ---- Fake-SMTP motion trigger ----
const smtp = createSmtpTrigger(config.smtp);
smtp.on('trigger', (trigger) => {
  log.info(`SMTP trigger from ${trigger.remote}: to=[${(trigger.to || []).join(', ')}] subject="${trigger.subject}"`);
  handleTrigger(trigger, 'smtp');
});
smtp.on('listening', ({ port, bind }) => log.info(`fake-SMTP motion trigger listening on ${bind}:${port}`));
smtp.on('error', (err) => log.error(`SMTP server error: ${err.message}`));

server.listen(config.port, () => {
  log.info(`dashboard on http://localhost:${config.port}`);
  log.info(`${config.cameras.length} camera(s) configured: ${config.cameras.map((c) => c.id).join(', ') || '(none)'}`);
  const autoCams = config.cameras.filter((c) => c.autoTriggerSeconds > 0);
  if (autoCams.length) {
    log.info(`auto-trigger enabled: ${autoCams.map((c) => `${c.id}@${c.autoTriggerSeconds}s`).join(', ')}`);
  }
  log.info(`LLM provider: ${config.llm.provider} — vision=${config.models.vision} escalation=${config.models.escalation}`);
  log.info(`log level: ${process.env.LOG_LEVEL || (process.env.WATCH_VERBOSE === '1' ? 'debug' : 'info')} (set WATCH_VERBOSE=1 or LOG_LEVEL=debug for more)`);
  if (!config.hasApiKey) log.warn(`no API key for LLM_PROVIDER=${config.llm.provider} — running with mock analysis.`);
  if (!config.transcribeCmd) log.warn('no TRANSCRIBE_CMD — argument meter will track raw loudness only.');
  if (!config.alerts.enabled) {
    log.info('Alexa alerts disabled');
  } else if (!alertRouter.rules.length) {
    log.info(`Alexa alerts enabled but no rules configured (bridge: ${config.alexa.url}) — see watchtower/alerts.json.example`);
  } else {
    log.info(`Alexa alerts: ${alertRouter.rules.length} rule(s) → ${config.alexa.url}`);
  }
  if (config.faces.enabled) {
    log.info(`face recognition: ${faceStore.count()} person(s) enrolled, match threshold ${config.faces.matchThreshold}`);
  } else {
    log.info('face recognition disabled (set FACES_ENABLED=1 to enable enrolment on the display webcam)');
  }
  if (config.water.enabled) {
    log.info(`water challenge: ${waterStore.count()} participant(s), goal ${config.water.dailyGoalMl}ml/day, dispenser ${esp32.configured ? config.water.esp32Url : 'MOCK (no ESP32 configured)'}`);
  } else {
    log.info('water challenge disabled (set WATER_ENABLED=1 to enable the hydration page)');
  }
});

function shutdown(signal) {
  log.info(`received ${signal} — shutting down`);
  autoScheduler.stopAll();
  if (alexaStatusTimer) clearInterval(alexaStatusTimer);
  // Safety: never leave the pump running across a restart.
  if (pourManager.isActive()) { log.warn('pour in progress at shutdown — stopping pump'); pourManager.stop('shutdown'); }
  try { smtp.close(); } catch (e) { log.warn(`error closing SMTP server: ${e.message}`); }
  server.close(() => { log.info('shutdown complete'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
