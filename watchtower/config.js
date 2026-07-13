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

const { isLocalUrl } = require('./analysis/providers/openai');

// Which LLM backend powers vision + escalation analysis. "openai" also covers
// any OpenAI-compatible endpoint (Azure OpenAI, Ollama, LM Studio, vLLM,
// Groq, OpenRouter, ...) via OPENAI_BASE_URL.
const llmProvider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// Model IDs are provider-specific, so pick sane per-provider defaults —
// VISION_MODEL/ESCALATION_MODEL still override either way.
const MODEL_DEFAULTS = {
  anthropic: { vision: 'claude-opus-4-8', escalation: 'claude-haiku-4-5' },
  openai: { vision: 'gpt-4o', escalation: 'gpt-4o-mini' },
};
const modelDefaults = MODEL_DEFAULTS[llmProvider] || MODEL_DEFAULTS.anthropic;

const openaiBaseUrl = process.env.OPENAI_BASE_URL || '';
const llmHasApiKey = llmProvider === 'openai' || llmProvider === 'openai-compatible'
  ? Boolean(process.env.OPENAI_API_KEY) || isLocalUrl(openaiBaseUrl)
  : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Minimum spacing between auto-triggers. Below this a misconfigured interval
// would hammer the camera and burn Claude vision calls for no benefit.
const MIN_AUTO_TRIGGER_SECONDS = 15;

const defaultAutoTriggerSeconds = Math.max(
  0, Number(process.env.WATCH_AUTO_TRIGGER_SECONDS || 0) || 0,
);

const rawCameras = readJsonEnvOrFile('WATCH_CAMERAS', 'cameras.json') || [];
const cameras = rawCameras.map((c, i) => {
  const requested = c.autoTriggerSeconds != null
    ? Number(c.autoTriggerSeconds)
    : defaultAutoTriggerSeconds;
  const autoTriggerSeconds = requested > 0
    ? Math.max(MIN_AUTO_TRIGGER_SECONDS, requested)
    : 0;
  return {
    id: c.id || slug(c.name) || `cam${i + 1}`,
    name: c.name || c.id || `Camera ${i + 1}`,
    rtsp: c.rtsp,
    audio: c.audio !== false && Boolean(c.rtsp),   // assume audio unless told otherwise
    trigger: (c.trigger || c.name || c.id || '').toLowerCase(),
    autoTriggerSeconds,
  };
});

const roster = readJsonEnvOrFile('WATCH_ROSTER', 'roster.json') || [];

// Alert rules: which events trigger an Alexa announcement, on which device,
// with what message template and how often. See alerts.json.example.
const rawAlerts = readJsonEnvOrFile('WATCH_ALERTS', 'alerts.json') || {};
const alerts = {
  enabled: rawAlerts.enabled !== false && process.env.ALEXA_ALERTS_ENABLED !== '0',
  device: rawAlerts.device || process.env.ALEXA_DEFAULT_DEVICE || 'all',
  cooldownSeconds: Number(rawAlerts.cooldownSeconds || process.env.ALEXA_DEFAULT_COOLDOWN_SECONDS || 120),
  rules: Array.isArray(rawAlerts.rules) ? rawAlerts.rules : [],
};

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
    vision: process.env.VISION_MODEL || modelDefaults.vision,
    escalation: process.env.ESCALATION_MODEL || modelDefaults.escalation,
  },
  llm: {
    provider: llmProvider,
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      // Empty -> api.openai.com. Set to point at Azure OpenAI, Ollama, LM
      // Studio, vLLM, Groq, OpenRouter, or any other OpenAI-compatible
      // /chat/completions endpoint.
      baseUrl: openaiBaseUrl,
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
    },
  },
  transcribeCmd: process.env.TRANSCRIBE_CMD || '',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  // Most cameras/NVRs speak RTSP-over-TCP fine, but some only support UDP
  // (or vice versa) — surfaced as "Output file does not contain any stream"
  // with no other explanation, so make it a one-line env override.
  ffmpegRtspTransport: /^(tcp|udp)$/i.test(process.env.FFMPEG_RTSP_TRANSPORT || '')
    ? process.env.FFMPEG_RTSP_TRANSPORT.toLowerCase()
    : 'tcp',
  statePath: path.join(__dirname, 'state.json'),
  facesPath: path.join(__dirname, 'faces.json'),
  waterPath: path.join(__dirname, 'water.json'),
  diaryPath: path.join(__dirname, 'diary.json'),
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  hasApiKey: llmHasApiKey,
  minAutoTriggerSeconds: MIN_AUTO_TRIGGER_SECONDS,
  faces: {
    // Face enrolment + recognition on the display's own webcam. Off by default;
    // it's a biometric feature, so it's opt-in.
    enabled: process.env.FACES_ENABLED === '1' || process.env.FACES_ENABLED === 'true',
    // Euclidean distance below which a live face is considered a match to an
    // enrolled one. Lower = stricter. face-api's typical sweet spot is ~0.5.
    matchThreshold: Number(process.env.FACES_MATCH_THRESHOLD || 0.5),
    // How many good samples to capture during enrolment.
    enrollSamples: Number(process.env.FACES_ENROLL_SAMPLES || 5),
    // How long an unknown face must linger (ms) before the "have we met?"
    // overlay appears — so passers-by and guests aren't prompted instantly.
    unknownDwellMs: Number(process.env.FACES_UNKNOWN_DWELL_MS || 4000),
  },
  alexa: {
    // The Alexa Bridge (github: local alexa-remote2-based announcement
    // service) runs as its own process — it owns the Amazon login/cookie
    // and exposes a small HTTP API. Watchtower is just a client of it.
    url: (process.env.ALEXA_BRIDGE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    timeoutMs: Number(process.env.ALEXA_BRIDGE_TIMEOUT_MS || 8000),
  },
  alerts,
  water: {
    // The hydration "water challenge" page + ESP32-controlled dispenser.
    enabled: process.env.WATER_ENABLED === '1' || process.env.WATER_ENABLED === 'true',
    // Per-person daily hydration goal, used to fill the swimlane droplets.
    dailyGoalMl: Number(process.env.WATER_DAILY_GOAL_ML || 2000),
    // Safety cutoffs for a single pour. The firmware enforces its own limits
    // too — never trust the network to stop a pump.
    maxPourMl: Number(process.env.WATER_MAX_POUR_ML || 1000),
    maxPourSeconds: Number(process.env.WATER_MAX_POUR_SECONDS || 60),
    // ESP32 dispenser HTTP endpoint. Empty → mock mode (simulated pours, so the
    // game works and is testable without hardware).
    esp32Url: (process.env.WATER_ESP32_URL || '').replace(/\/$/, ''),
    esp32TimeoutMs: Number(process.env.WATER_ESP32_TIMEOUT_MS || 4000),
    // Simulated flow rate used only in mock mode.
    mockFlowMlPerSec: Number(process.env.WATER_MOCK_FLOW_ML_PER_SEC || 50),
  },
  diary: {
    // "Dear Diary" — wake-word-activated video diary entries, uploaded to
    // Google Drive. Off by default; needs a wake word to listen for and (to
    // actually save anything) a Drive folder shared with a service account.
    enabled: process.env.DIARY_ENABLED === '1' || process.env.DIARY_ENABLED === 'true',
    wakeWord: (process.env.DIARY_WAKE_WORD || 'dear diary').toLowerCase(),
    // How long the big countdown dot counts down before recording starts.
    countdownSeconds: Number(process.env.DIARY_COUNTDOWN_SECONDS || 5),
    // Hard cap on a single entry's length.
    maxSeconds: Number(process.env.DIARY_MAX_SECONDS || 60),
    // Prompts shown on screen while recording, for anyone stuck on what to say.
    // Pipe-separated in the env var, e.g. "What did you do today?|Tell a joke".
    suggestions: process.env.DIARY_SUGGESTIONS
      ? process.env.DIARY_SUGGESTIONS.split('|').map((s) => s.trim()).filter(Boolean)
      : [
        'What did you do today?',
        'How are you feeling?',
        'Tell a joke, or tell a story',
        'Show something interesting',
        'What made you laugh today?',
        'What are you looking forward to?',
      ],
    drive: {
      // The Drive folder entries get uploaded into. Share it with the service
      // account's client_email (from the JSON key below) as an Editor.
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
      // Full service-account JSON key, inline (see README for how to create
      // one). Without this + folderId, entries are still recorded locally
      // but never leave the device.
      serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
      // Manifest file kept alongside the videos in the Drive folder, listing
      // every entry (filename, link, timestamp, duration) for easy browsing.
      indexFileName: process.env.GOOGLE_DRIVE_INDEX_FILENAME || 'dear-diary-index.json',
    },
  },
};
