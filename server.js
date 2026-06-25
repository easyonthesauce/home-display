require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { LocalDevice, dpsToStatusArray } = require('./src/tuya');
const { normalize } = require('./src/metrics');

const PORT = Number(process.env.PORT || 3000);
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 5000);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 1000);

// .env format:  id:localKey:Label[:ip],id2:localKey2:Label2[:ip2]
// version + dp map overrides come from separate vars to keep this readable.
function parseDevices(spec) {
  return (spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':').map((p) => p.trim());
      const [id, key, label, ip] = parts;
      if (!id || !key) throw new Error(`Bad TUYA_DEVICES entry "${entry}". Expected id:localKey:Label[:ip]`);
      return { id, key, label: label || id, ip: ip || undefined };
    });
}

function parseDpOverrides(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Ignoring TUYA_DPS_OVERRIDES — not valid JSON: ${err.message}`);
    return {};
  }
}

const devices = parseDevices(process.env.TUYA_DEVICES);
if (!devices.length) {
  console.error('No TUYA_DEVICES configured. Copy .env.example to .env and set it.');
  process.exit(1);
}

const dpOverrides = parseDpOverrides(process.env.TUYA_DPS_OVERRIDES);
const version = process.env.TUYA_PROTOCOL_VERSION || '3.3';

const snapshots = new Map();

function emitSnapshot(dev, extra = {}) {
  const status = dpsToStatusArray(dev.dps, dpOverrides);
  const snap = normalize(
    { id: dev.id, label: dev.label, online: dev.online, name: dev.label },
    status,
  );
  snap.error = extra.error || (dev.online ? null : dev.lastError);
  snap.extra.dpsRaw = { ...dev.dps };
  snapshots.set(dev.id, snap);
}

const clients = devices.map((d) => {
  const dev = new LocalDevice({
    id: d.id,
    key: d.key,
    ip: d.ip,
    label: d.label,
    version,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  });

  dev.on('dps', () => emitSnapshot(dev));
  dev.on('online',  () => { console.log(`[tuya] ${d.label} connected`); emitSnapshot(dev); });
  dev.on('offline', () => { console.log(`[tuya] ${d.label} disconnected`); emitSnapshot(dev); });
  dev.on('error',   (err) => {
    console.warn(`[tuya] ${d.label} error: ${err.message || err}`);
    emitSnapshot(dev, { error: err.message || String(err) });
  });

  emitSnapshot(dev);
  dev.start().catch((err) => console.warn(`[tuya] ${d.label} start failed: ${err.message}`));
  return dev;
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/snapshot', (_req, res) => {
  res.json({
    ts: Date.now(),
    devices: Array.from(snapshots.values()),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast() {
  if (!wss.clients.size) return;
  const payload = JSON.stringify({
    type: 'snapshot',
    devices: Array.from(snapshots.values()),
    ts: Date.now(),
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'snapshot',
    devices: Array.from(snapshots.values()),
    ts: Date.now(),
  }));
});

// Push-style snapshots come in as DPs arrive, but we also batch-broadcast at
// a steady cadence so multiple clients stay in sync and stale timers tick.
setInterval(broadcast, BROADCAST_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`home-display ready on http://localhost:${PORT}`);
  console.log(`connecting to ${devices.length} device(s) over LAN (protocol v${version})`);
});

function shutdown() {
  for (const c of clients) c.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
