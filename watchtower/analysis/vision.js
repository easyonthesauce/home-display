const config = require('../config');
const { createLogger } = require('../logger');
const { getClient, responseText } = require('./client');
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
        ? 'Analysis unavailable — check the Anthropic API key / model.'
        : `Mock analysis (${frameCount} frames captured). Set ANTHROPIC_API_KEY for real analysis.`,
    ],
    mess_score: 0,
    child_wellbeing: { risk_level: 'none', notes: '' },
    environment_risks: [],
    vibe: { score: 50, label: 'unknown' },
  }, camera);
}

async function analyzeScene(camera, frames) {
  const client = getClient();
  if (!client) {
    log.warn(`no Anthropic client available (missing API key?) — returning mock scene for "${camera.name}"`);
    return mockScene(camera, frames ? frames.length : 0);
  }
  if (!frames || !frames.length) {
    log.warn(`no frames captured for "${camera.name}" — returning mock scene`);
    return mockScene(camera, 0);
  }

  const content = [];
  frames.forEach((buf, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1} of ${frames.length}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
  });
  content.push({
    type: 'text',
    text: `Camera: ${camera.name}.\nHousehold roster:\n${rosterText(config.roster)}\n\n`
      + `These ${frames.length} frames were captured over ~${config.clipSeconds}s. Analyse them and return the JSON.`,
  });

  const start = Date.now();
  log.info(`analysing ${frames.length} frame(s) from "${camera.name}" with ${config.models.vision}`);
  try {
    const resp = await client.messages.create({
      model: config.models.vision,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: sceneSchema } },
      system: sceneSystem,
      messages: [{ role: 'user', content }],
    });
    log.debug(
      `vision response for "${camera.name}" in ${Date.now() - start}ms: `
      + `usage=${JSON.stringify(resp.usage || {})} stop_reason=${resp.stop_reason}`,
    );
    const parsed = JSON.parse(responseText(resp));
    return sanitize(parsed, camera);
  } catch (e) {
    log.error(`vision analysis failed for "${camera.name}" after ${Date.now() - start}ms: ${e.message}`);
    const scene = mockScene(camera, frames.length);
    scene.notable_observations = [`Analysis error: ${e.message}`];
    return scene;
  }
}

module.exports = { analyzeScene };
