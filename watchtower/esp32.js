const { createLogger } = require('./logger');

const log = createLogger('esp32');

// HTTP client for the ESP32 water dispenser (ESP32 + 4-relay board + 12V pump +
// flow meter). Watchtower calls this to switch the pump relay on/off; the ESP32
// pushes measured flow back to Watchtower's /api/water/flow endpoint.
//
// Expected firmware endpoints (see watchtower/esp32/):
//   POST /pump/on   { maxMl, maxSeconds }  -> starts the pump with hardware-side
//                                             safety limits, returns { ok }
//   POST /pump/off                         -> stops the pump, returns { ok, ml }
//   GET  /status                           -> { ok, pumping, ml }
//
// When no URL is configured the client reports as unavailable and the server
// falls back to a simulated pour so the game still works without hardware.
function createEsp32Client({ url, timeoutMs }) {
  const configured = Boolean(url);

  async function request(path, { method = 'GET', body } = {}) {
    if (!configured) throw new Error('no ESP32 configured');
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
      if (!res.ok) throw new Error(data.error || `esp32 responded ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured,
    async pumpOn({ maxMl, maxSeconds }) {
      log.info(`pump ON (limits: ${maxMl}ml / ${maxSeconds}s)`);
      return request('/pump/on', { method: 'POST', body: { maxMl, maxSeconds } });
    },
    async pumpOff() {
      log.info('pump OFF');
      return request('/pump/off', { method: 'POST' });
    },
    async status() {
      try { return await request('/status'); }
      catch (e) { return { ok: false, error: e.message }; }
    },
  };
}

module.exports = { createEsp32Client };
