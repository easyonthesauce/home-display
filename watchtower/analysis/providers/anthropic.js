const { createLogger } = require('../../logger');

const log = createLogger('llm:anthropic');

// Wraps the Anthropic Messages API behind the provider-agnostic `complete()`
// interface used by vision.js / escalation.js. Lazily constructs the SDK
// client so a missing key/package degrades to "unavailable" rather than
// crashing the process.
function createAnthropicProvider({ apiKey }) {
  let client = null;
  let attempted = false;

  function getClient() {
    if (attempted) return client;
    attempted = true;
    if (!apiKey) {
      log.debug('no API key configured — client will not be constructed');
      return null;
    }
    try {
      const pkg = require('@anthropic-ai/sdk');
      const Anthropic = pkg.Anthropic || pkg.default || pkg;
      client = new Anthropic({ apiKey });
      log.debug('client constructed');
    } catch (e) {
      log.error(`Anthropic SDK unavailable: ${e.message}`);
      client = null;
    }
    return client;
  }

  return {
    name: 'anthropic',
    available: () => Boolean(getClient()),

    // { model, maxTokens, system, prompt, images?: [{mediaType, base64}], schema? }
    // -> { text, usage, stopReason }
    async complete({ model, maxTokens, system, prompt, images, schema }) {
      const anthropic = getClient();
      if (!anthropic) throw new Error('Anthropic client unavailable (missing API key or SDK)');

      const content = [];
      for (const img of images || []) {
        if (img.caption) content.push({ type: 'text', text: img.caption });
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      }
      content.push({ type: 'text', text: prompt });

      const resp = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        ...(schema ? { output_config: { effort: 'low', format: { type: 'json_schema', schema } } } : {}),
        system,
        messages: [{ role: 'user', content }],
      });

      const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, usage: resp.usage, stopReason: resp.stop_reason };
    },
  };
}

module.exports = { createAnthropicProvider };
