require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { TuyaClient } = require('./src/tuya');
const { normalize } = require('./src/metrics');

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);

function parseDevices(spec) {
  return (spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...rest] = entry.split(':');
      return { id: id.trim(), label: rest.join(':').trim() || id.trim() };
    });
}

const devices = parseDevices(process.env.TUYA_DEVICE_IDS);
if (!devices.length) {
  console.error('No TUYA_DEVICE_IDS configured. Copy .env.example to .env and set it.');
  process.exit(1);
}

const tuya = new TuyaClient({
  clientId: process.env.TUYA_CLIENT_ID,
  clientSecret: process.env.TUYA_CLIENT_SECRET,
  region: (process.env.TUYA_REGION || 'eu').toLowerCase(),
});

const deviceMeta = new Map(devices.map((d) => [d.id, { ...d }]));
const lastSnapshot = new Map();

async function refreshMeta() {
  await Promise.all(
    devices.map(async (d) => {
      try {
        const info = await tuya.getDeviceInfo(d.id);
        const meta = deviceMeta.get(d.id);
        meta.name = info?.name || meta.label;
        meta.online = info?.online ?? true;
        meta.category = info?.category;
      } catch (err) {
        console.warn(`[meta] ${d.id}: ${err.message}`);
      }
    }),
  );
}

async function pollOnce() {
  const results = await Promise.all(
    devices.map(async (d) => {
      const meta = deviceMeta.get(d.id);
      try {
        const status = await tuya.getDeviceStatus(d.id);
        const snap = normalize(meta, status);
        lastSnapshot.set(d.id, snap);
        return snap;
      } catch (err) {
        const snap = {
          id: d.id,
          label: meta.label,
          name: meta.name,
          online: false,
          error: err.message,
          updatedAt: Date.now(),
          metrics: {},
          phases: {},
          extra: {},
        };
        lastSnapshot.set(d.id, snap);
        return snap;
      }
    }),
  );
  broadcast({ type: 'snapshot', devices: results, ts: Date.now() });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/snapshot', (_req, res) => {
  res.json({
    ts: Date.now(),
    devices: Array.from(lastSnapshot.values()),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'snapshot',
    devices: Array.from(lastSnapshot.values()),
    ts: Date.now(),
  }));
});

(async () => {
  try {
    await refreshMeta();
  } catch (err) {
    console.warn('[startup] meta refresh failed:', err.message);
  }
  await pollOnce().catch((err) => console.warn('[startup] poll failed:', err.message));
  setInterval(() => {
    pollOnce().catch((err) => console.warn('[poll]', err.message));
  }, POLL_INTERVAL_MS);
  setInterval(() => {
    refreshMeta().catch(() => {});
  }, 5 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`home-display ready on http://localhost:${PORT}`);
    console.log(`polling ${devices.length} device(s) every ${POLL_INTERVAL_MS}ms`);
  });
})();
