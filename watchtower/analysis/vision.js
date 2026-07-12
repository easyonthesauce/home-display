const config = require('../config');
const { createLogger } = require('../logger');
const { getProvider } = require('./providers');
const { sceneSchema, sceneSystem, rosterText } = require('./prompts');

const log = createLogger('vision');

const clampInt = (n, lo, hi, dflt) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
};

// Normalise + clamp whatever the model returns so the dashboard always gets a
// well-formed scene, even if a field drifts out of range.
function sanitize(raw, camera) {
  const people = Array.isArray(raw.people) ? raw.people.map((p) => ({
    identity: String(p.identity || 'unknown'),
    confidence: p.confidence || 'unknown',
    doing: String(p.doing || ''),
    effort: clampInt(p.effort, 0, 100, 0),
  })) : [];
  return {
    cameraId: camera.id,
    camera: camera.name,
    at: Date.now(),
    people_count: clampInt(raw.people_count, 0, 99, people.length),
    people,
    activities: Array.isArray(raw.activities) ? raw.activities.map(String) : [],
    notable_observations: Array.isArray(raw.notable_observations) ? raw.notable_observations.map(String) : [],
    mess_score: clampInt(raw.mess_score, 0, 10, 0),
    child_wellbeing: {
      risk_level: (raw.child_wellbeing && raw.child_wellbeing.risk_level) || 'none',
      notes: (raw.child_wellbeing && String(raw.child_wellbeing.notes || '')) || '',
    },
    environment_risks: Array.isArray(raw.environment_risks)
      ? raw.environment_risks.map((r) => ({ risk: String(r.risk || ''), severity: r.severity || 'low' }))
      : [],
    vibe: {
      score: clampInt(raw.vibe && raw.vibe.score, 0, 100, 50),
      label: (raw.vibe && String(raw.vibe.label || '')) || '—',
    },
  };
}

function mockScene(camera, frameCount) {
  return sanitize({
    people_count: 0,
    people: [],
    activities: [],
    notable_observations: [
      config.hasApiKey
        ? `Analysis unavailable — check the ${config.llm.provider} API key / model.`
        : `Mock analysis (${frameCount} frames captured). Configure an LLM provider (LLM_PROVIDER, API key) for real analysis.`,
    ],
    mess_score: 0,
    child_wellbeing: { risk_level: 'none', notes: '' },
    environment_risks: [],
    vibe: { score: 50, label: 'unknown' },
  }, camera);
}

async function analyzeScene(camera, frames) {
  const provider = getProvider(config);
  if (!provider.available()) {
    log.warn(`no LLM provider available (${config.llm.provider}, missing API key?) — returning mock scene for "${camera.name}"`);
    return mockScene(camera, frames ? frames.length : 0);
  }
  if (!frames || !frames.length) {
    log.warn(`no frames captured for "${camera.name}" — returning mock scene`);
    return mockScene(camera, 0);
  }

  const images = frames.map((buf, i) => ({
    mediaType: 'image/jpeg',
    base64: buf.toString('base64'),
    caption: `Frame ${i + 1} of ${frames.length}:`,
  }));
  const prompt = `Camera: ${camera.name}.\nHousehold roster:\n${rosterText(config.roster)}\n\n`
    + `These ${frames.length} frames were captured over ~${config.clipSeconds}s, in order. Analyse them and return the JSON.`;

  const start = Date.now();
  log.info(`analysing ${frames.length} frame(s) from "${camera.name}" with ${provider.name}:${config.models.vision}`);
  try {
    const resp = await provider.complete({
      model: config.models.vision,
      maxTokens: 4000,
      system: sceneSystem,
      prompt,
      images,
      schema: sceneSchema,
    });
    log.debug(
      `vision response for "${camera.name}" in ${Date.now() - start}ms: `
      + `usage=${JSON.stringify(resp.usage || {})} stop_reason=${resp.stopReason}`,
    );
    const parsed = JSON.parse(resp.text);
    return sanitize(parsed, camera);
  } catch (e) {
    log.error(`vision analysis failed for "${camera.name}" after ${Date.now() - start}ms: ${e.message}`);
    const scene = mockScene(camera, frames.length);
    scene.notable_observations = [`Analysis error: ${e.message}`];
    return scene;
  }
}

module.exports = { analyzeScene };
