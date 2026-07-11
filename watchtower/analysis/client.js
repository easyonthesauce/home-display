const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('client');

// Lazily construct one shared Anthropic client. Returns null when no API key is
// configured, so the rest of the app can fall back to mock analysis and still
// run end-to-end (useful for wiring up cameras before adding a key).
let client = null;
let attempted = false;

function getClient() {
  if (attempted) return client;
  attempted = true;
  if (!config.hasApiKey) {
    log.debug('no API key configured — client will not be constructed');
    return null;
  }
  try {
    const pkg = require('@anthropic-ai/sdk');
    const Anthropic = pkg.Anthropic || pkg.default || pkg;
    client = new Anthropic();          // reads ANTHROPIC_API_KEY from the env
    log.debug('Anthropic client constructed');
  } catch (e) {
    log.error(`Anthropic SDK unavailable: ${e.message}`);
    client = null;
  }
  return client;
}

// Pull the concatenated text out of a Messages response, skipping thinking blocks.
function responseText(resp) {
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

module.exports = { getClient, responseText };
