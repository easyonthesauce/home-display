require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { createSmtpTrigger } = require('./smtp-trigger');
const { createEventBus } = require('./events');
const { createStore } = require('./state');
const { captureFrames, captureAudio } = require('./capture');
const { analyzeScene } = require('./analysis/vision');
const { classifyEscalation } = require('./analysis/escalation');
const { transcribe } = require('./analysis/transcribe');
const { createAudioAnalyzer } = require('./analysis/audio');

const bus = createEventBus({ webhooks: config.webhooks });
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
  return matched || config.cameras[0] || null;
}

// A motion trigger arrived (from the fake SMTP server or the manual test route):
// grab frames, analyse, remember, and broadcast the scene.
let analyzing = new Set();
async function handleTrigger(trigger, source) {
  const camera = resolveCamera(trigger);
  if (!camera) { console.warn('[trigger] no cameras configured'); return; }
  if (analyzing.has(camera.id)) return;               // debounce repeat motion on the same camera
  analyzing.add(camera.id);

  bus.emit('trigger', { camera: camera.name, cameraId: camera.id, source, subject: trigger.subject });
  try {
    let frames = [];
    try {
      frames = await captureFrames(camera.rtsp, {
        seconds: config.clipSeconds, count: config.frameCount, ffmpeg: config.ffmpeg,
      });
    } catch (e) {
      bus.emit('capture.error', { camera: camera.name, message: e.message });
    }
    const scene = await analyzeScene(camera, frames);
    latestScenes.set(camera.id, scene);
    store.applyScene(scene);
    bus.emit('scene.update', scene);

    if (['elevated', 'high'].includes(scene.child_wellbeing.risk_level)) {
      bus.emit('alert.child', { camera: camera.name, ...scene.child_wellbeing });
    }
    const highRisks = scene.environment_risks.filter((r) => r.severity === 'high');
    if (highRisks.length) bus.emit('alert.hazard', { camera: camera.name, risks: highRisks });
  } finally {
    analyzing.delete(camera.id);
  }
}

// When a raised-voices event ends, the people identifiable in the last scene of
// the audio camera become the "offenders" for the name-and-shame board.
bus.on('audio.end', (payload) => {
  if (!payload || payload.peak < 55) return;   // only count genuinely heated moments
  const scene = latestScenes.get(config.audioCameraId);
  const offenders = scene ? scene.people
    .filter((p) => p.identity && !/^unknown/i.test(p.identity))
    .map((p) => p.identity) : [];
  const incident = { peak: payload.peak, offenders, recognized: [] };
  store.applyIncident(incident);
  bus.emit('incident.recorded', incident);
});

// ---- HTTP + WebSocket ----
const app = express();
app.use(express.json());
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
  const started = audio.start('browser-loud');
  res.json({ started, active: audio.isActive() });
});

// Continuous loudness updates while an event is in progress.
app.post('/api/audio/level', (req, res) => {
  latestNoise = Math.max(0, Math.min(100, Number(req.body && req.body.level) || 0));
  res.json({ ok: true });
});

// Sustained quiet from the display — wind the session down.
app.post('/api/audio/quiet', (_req, res) => {
  audio.stop();
  latestNoise = 0;
  res.json({ ok: true });
});

// Manually fire a motion trigger (for testing without an NVR).
app.post('/api/trigger/test', (req, res) => {
  const cameraId = req.query.camera || (req.body && req.body.camera);
  const cam = config.cameras.find((c) => c.id === cameraId) || config.cameras[0];
  handleTrigger({ to: cam ? [cam.trigger] : [], subject: 'manual test', from: 'test' }, 'manual');
  res.json({ ok: true, camera: cam && cam.name });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  bus.addClient(ws);
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
  ws.on('close', () => bus.removeClient(ws));
  ws.on('error', () => bus.removeClient(ws));
});

// ---- Fake-SMTP motion trigger ----
const smtp = createSmtpTrigger(config.smtp);
smtp.on('trigger', (trigger) => handleTrigger(trigger, 'smtp'));
smtp.on('listening', ({ port, bind }) => console.log(`watchtower: fake-SMTP motion trigger on ${bind}:${port}`));
smtp.on('error', (err) => console.error(`[smtp] ${err.message}`));

server.listen(config.port, () => {
  console.log(`watchtower: dashboard on http://localhost:${config.port}`);
  console.log(`watchtower: ${config.cameras.length} camera(s); vision=${config.models.vision}, escalation=${config.models.escalation}`);
  if (!config.hasApiKey) console.log('watchtower: no ANTHROPIC_API_KEY — running with mock analysis.');
  if (!config.transcribeCmd) console.log('watchtower: no TRANSCRIBE_CMD — argument meter will track raw loudness only.');
});

function shutdown() { try { smtp.close(); } catch {} server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
