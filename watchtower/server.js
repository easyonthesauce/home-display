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

const log = createLogger('server');

const bus = createEventBus({ webhooks: config.webhooks, log: createLogger('events') });
const store = createStore({ file: config.statePath });

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
app.use(express.json());
app.use((req, _res, next) => {
  log.debug(`${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (_req, res) => {
  res.json({
    cameras: config.cameras.map((c) => ({ id: c.id, name: c.name, audio: c.audio })),
    scenes: Array.from(latestScenes.values()),
    store: store.snapshot(),
    audioActive: audio.isActive(),
    noise: latestNoise,
    hasApiKey: config.hasApiKey,
    hasTranscriber: Boolean(config.transcribeCmd),
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
      hasApiKey: config.hasApiKey,
      hasTranscriber: Boolean(config.transcribeCmd),
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
  log.info(`models: vision=${config.models.vision} escalation=${config.models.escalation}`);
  log.info(`log level: ${process.env.LOG_LEVEL || (process.env.WATCH_VERBOSE === '1' ? 'debug' : 'info')} (set WATCH_VERBOSE=1 or LOG_LEVEL=debug for more)`);
  if (!config.hasApiKey) log.warn('no ANTHROPIC_API_KEY — running with mock analysis.');
  if (!config.transcribeCmd) log.warn('no TRANSCRIBE_CMD — argument meter will track raw loudness only.');
});

function shutdown(signal) {
  log.info(`received ${signal} — shutting down`);
  try { smtp.close(); } catch (e) { log.warn(`error closing SMTP server: ${e.message}`); }
  server.close(() => { log.info('shutdown complete'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
