const config = require('../config');
const { createLogger } = require('../logger');
const { getClient, responseText } = require('./client');
const { escalationSchema, escalationSystem } = require('./prompts');

const log = createLogger('escalation');

const clamp = (n, lo, hi, dflt) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
};

// Classify the current emotional intensity of a rolling transcript window using
// a fast, cheap model (Haiku by default) — this runs every few seconds during a
// live audio event, so latency and cost matter more than depth here.
// `noiseFallback` (0-100) is used when there's no transcript available (e.g. no
// transcriber configured) so the meter still tracks raw loudness.
async function classifyEscalation(transcriptWindow, noiseFallback = 0) {
  const hasText = transcriptWindow && transcriptWindow.trim() && transcriptWindow !== '(no transcript available)';
  const client = getClient();

  if (!client || !hasText) {
    const level = clamp(noiseFallback, 0, 100, 0);
    log.debug(`fallback path: hasClient=${Boolean(client)} hasText=${Boolean(hasText)} noise=${level}`);
    return {
      escalation: level,
      trend: 'stable',
      tone: level > 60 ? 'loud' : 'quiet',
      summary: hasText ? 'Transcript available but analysis is offline.' : 'Tracking raw noise level (no transcript).',
    };
  }

  const start = Date.now();
  log.debug(`classifying escalation with ${config.models.escalation} (transcript window: ${transcriptWindow.length} chars)`);
  try {
    const resp = await client.messages.create({
      model: config.models.escalation,
      max_tokens: 400,
      output_config: { format: { type: 'json_schema', schema: escalationSchema } },
      system: escalationSystem,
      messages: [{ role: 'user', content: `Recent transcript (oldest first, newest last):\n"""\n${transcriptWindow}\n"""\n\nReturn the JSON.` }],
    });
    const raw = JSON.parse(responseText(resp));
    const result = {
      escalation: clamp(raw.escalation, 0, 100, noiseFallback),
      trend: ['escalating', 'stable', 'de-escalating'].includes(raw.trend) ? raw.trend : 'stable',
      tone: String(raw.tone || 'normal'),
      summary: String(raw.summary || ''),
    };
    log.debug(`escalation=${result.escalation} trend=${result.trend} tone="${result.tone}" (${Date.now() - start}ms)`);
    return result;
  } catch (e) {
    log.warn(`escalation classification failed after ${Date.now() - start}ms: ${e.message}`);
    return { escalation: clamp(noiseFallback, 0, 100, 0), trend: 'stable', tone: 'unknown', summary: `Analysis error: ${e.message}` };
  }
}

module.exports = { classifyEscalation };
