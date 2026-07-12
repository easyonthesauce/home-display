const { createLogger } = require('../../logger');
const { createAnthropicProvider } = require('./anthropic');
const { createOpenAIProvider } = require('./openai');

const log = createLogger('llm');

let cached = null;
let cachedKind = null;

// Returns the active LLM provider (constructed once and reused), selected by
// config.llm.provider. Both vision.js and escalation.js call this instead of
// talking to any SDK directly, so swapping providers is a config change, not
// a code change.
function getProvider(config) {
  const kind = (config.llm.provider || 'anthropic').toLowerCase();
  if (cached && cachedKind === kind) return cached;

  if (kind === 'openai' || kind === 'openai-compatible') {
    cached = createOpenAIProvider(config.llm.openai);
  } else {
    if (kind !== 'anthropic') log.warn(`unknown LLM_PROVIDER "${kind}" — falling back to anthropic`);
    cached = createAnthropicProvider(config.llm.anthropic);
  }
  cachedKind = kind;

  const detail = cached.name === 'openai' && config.llm.openai.baseUrl
    ? ` (${config.llm.openai.baseUrl})` : '';
  log.info(`active LLM provider: ${cached.name}${detail} — available=${cached.available()}`);
  return cached;
}

module.exports = { getProvider };
