const fs = require('fs');
const path = require('path');

// Config comes from env vars first, then optional JSON files in this directory
// (cameras.json / roster.json), so secrets can stay in .env while the bulkier
// camera + household lists live in readable files.
function readJsonEnvOrFile(envName, fileName) {
  const raw = process.env[envName];
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); } catch (e) {
      console.warn(`[config] ${envName} is not valid JSON: ${e.message}`);
    }
  }
  const filePath = path.join(__dirname, fileName);
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {
      console.warn(`[config] ${fileName} is not valid JSON: ${e.message}`);
    }
  }
  return null;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const rawCameras = readJsonEnvOrFile('WATCH_CAMERAS', 'cameras.json') || [];
const cameras = rawCameras.map((c, i) => ({
  id: c.id || slug(c.name) || `cam${i + 1}`,
  name: c.name || c.id || `Camera ${i + 1}`,
  rtsp: c.rtsp,
  audio: c.audio !== false && Boolean(c.rtsp),   // assume audio unless told otherwise
  trigger: (c.trigger || c.name || c.id || '').toLowerCase(),
}));

const roster = readJsonEnvOrFile('WATCH_ROSTER', 'roster.json') || [];

module.exports = {
  port: Number(process.env.WATCH_PORT || 4000),
  smtp: {
    port: Number(process.env.SMTP_PORT || 2525),
    bind: process.env.SMTP_BIND || '0.0.0.0',
    hostname: process.env.SMTP_HOSTNAME || 'watchtower.local',
  },
  clipSeconds: Number(process.env.CLIP_SECONDS || 10),
  frameCount: Number(process.env.FRAME_COUNT || 8),
  audioChunkSeconds: Number(process.env.AUDIO_CHUNK_SECONDS || 5),
  cameras,
  roster,
  audioCameraId: process.env.WATCH_AUDIO_CAMERA || (cameras[0] && cameras[0].id) || null,
  webhooks: (process.env.WATCH_WEBHOOKS || '').split(',').map((s) => s.trim()).filter(Boolean),
  models: {
    vision: process.env.VISION_MODEL || 'claude-opus-4-8',
    escalation: process.env.ESCALATION_MODEL || 'claude-haiku-4-5',
  },
  transcribeCmd: process.env.TRANSCRIBE_CMD || '',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  statePath: path.join(__dirname, 'state.json'),
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
};
