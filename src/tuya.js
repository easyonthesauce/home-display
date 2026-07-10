// Local LAN client for Tuya energy monitors. No cloud API required at runtime.
//
// We open a persistent TCP connection to each device and react to the `data`
// and `dp-refresh` events the device pushes when its DPs change. As a safety
// net (some devices stop pushing after a while), we also call refresh() on a
// timer. Disconnections trigger an exponential-backoff reconnect.

const EventEmitter = require('events');
const TuyAPI = require('tuyapi');

class LocalDevice extends EventEmitter {
  constructor({ id, key, ip, version = '3.3', label, refreshIntervalMs = 5000 }) {
    super();
    if (!id || !key) throw new Error('id and key are required');
    this.id = id;
    this.label = label || id;
    this.ip = ip;
    this.version = version;
    this.refreshIntervalMs = refreshIntervalMs;
    this.online = false;
    this.lastError = null;
    this.dps = {};
    this._reconnectDelay = 1000;
    this._stopped = false;

    this._tuya = new TuyAPI({
      id,
      key,
      ip,
      version,
      issueRefreshOnConnect: true,
    });

    this._tuya.on('connected', () => {
      this.online = true;
      this._reconnectDelay = 1000;
      this.emit('online');
      this._scheduleRefresh();
    });

    this._tuya.on('disconnected', () => {
      this.online = false;
      this.emit('offline');
      this._clearRefresh();
      this._scheduleReconnect();
    });

    this._tuya.on('error', (err) => {
      this.lastError = err.message || String(err);
      this.emit('error', err);
    });

    const ingest = (data) => {
      if (!data || !data.dps) return;
      Object.assign(this.dps, data.dps);
      this.emit('dps', this.dps);
    };
    this._tuya.on('data', ingest);
    this._tuya.on('dp-refresh', ingest);
  }

  async start() {
    this._stopped = false;
    await this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearRefresh();
    try { this._tuya.disconnect(); } catch { /* ignore */ }
  }

  async _connect() {
    if (this._stopped) return;
    try {
      if (!this.ip) {
        // Auto-discover by listening for the device's UDP broadcast.
        await this._tuya.find({ timeout: 10 });
      }
      await this._tuya.connect();
    } catch (err) {
      this.lastError = err.message || String(err);
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = Math.min(this._reconnectDelay, 30_000);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
    setTimeout(() => this._connect(), delay);
  }

  _scheduleRefresh() {
    this._clearRefresh();
    this._refreshTimer = setInterval(() => {
      this._tuya.refresh({ schema: true }).catch((err) => {
        this.lastError = err.message || String(err);
      });
    }, this.refreshIntervalMs);
  }

  _clearRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }
}

// Tuya's local protocol identifies DPs by integer index, not by code name.
// Schemas vary by device. We map common indexes used by single-phase and
// 3-phase energy monitors back to the canonical codes that `metrics.js`
// already understands, so the rest of the app stays the same.
//
// If your device uses different indexes, set TUYA_DPS_OVERRIDES in .env or
// inspect the raw `dps` shown on each card (we expose them under `extra.dpsRaw`).
const DEFAULT_DP_MAP = {
  1:  'switch',
  17: 'add_ele',         // 0.01 kWh
  18: 'cur_current',     // mA
  19: 'cur_power',       // 0.1 W
  20: 'cur_voltage',     // 0.1 V
  101: 'phase_a',
  102: 'phase_b',
  103: 'phase_c',
  131: 'frequency',
  132: 'power_factor',
};

function dpsToStatusArray(dps, overrides = {}) {
  const map = { ...DEFAULT_DP_MAP, ...overrides };
  const out = [];
  for (const [k, v] of Object.entries(dps)) {
    const code = map[k] || `dp_${k}`;
    out.push({ code, value: v });
  }
  return out;
}

module.exports = { LocalDevice, dpsToStatusArray, DEFAULT_DP_MAP };
