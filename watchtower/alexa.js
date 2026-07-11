const { createLogger } = require('./logger');

const log = createLogger('alexa');

// Thin client for the "Alexa Bridge" sidecar service — a separate process
// (built on alexa-remote2) that owns the Amazon login/cookie and exposes a
// small local HTTP API for announcements. Watchtower never talks to Amazon
// directly; it only ever calls this bridge, and degrades gracefully (log +
// continue) if the bridge is unreachable or not configured, since a missing
// Alexa isn't a reason to break camera analysis.
//
// Bridge API (see the alexa-bridge project's server.js):
//   GET  /status                    { status: "connected" | "disconnected" }
//   POST /announce  { message, device } | { message, all: true }
//   POST /speak     { message, device }
function createAlexaClient({ url, timeoutMs }) {
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `bridge responded ${res.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function announce(message, device) {
    const body = device && device.toLowerCase() === 'all'
      ? { message, all: true }
      : { message, device };
    const start = Date.now();
    try {
      const result = await request('/announce', { method: 'POST', body });
      log.info(`announced to ${device || 'all'} in ${Date.now() - start}ms: "${message}"`);
      return result;
    } catch (e) {
      log.warn(`announce failed (device=${device}) after ${Date.now() - start}ms: ${e.message}`);
      throw e;
    }
  }

  async function status() {
    try {
      return await request('/status');
    } catch (e) {
      log.debug(`status check failed: ${e.message}`);
      return { status: 'unreachable', error: e.message };
    }
  }

  return { announce, status };
}

module.exports = { createAlexaClient };
