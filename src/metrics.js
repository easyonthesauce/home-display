// Tuya energy monitors return device-point (DP) status codes that vary by model.
// We map known codes to a canonical schema with scaling + units so the dashboard
// can render whatever the device exposes without per-device frontend work.
//
// Anything unknown is still passed through under `extra` so it can be debugged.

const SCALAR_METRICS = {
  cur_power:        { key: 'power',   unit: 'W',   scale: 0.1 },  // 0.1 W
  power:            { key: 'power',   unit: 'W',   scale: 1   },
  cur_voltage:      { key: 'voltage', unit: 'V',   scale: 0.1 },  // 0.1 V
  voltage:          { key: 'voltage', unit: 'V',   scale: 1   },
  cur_current:      { key: 'current', unit: 'A',   scale: 0.001 },// mA
  current:          { key: 'current', unit: 'A',   scale: 0.001 },
  add_ele:          { key: 'energy',  unit: 'kWh', scale: 0.01 },
  forward_energy_total: { key: 'energy', unit: 'kWh', scale: 0.01 },
  total_forward_energy: { key: 'energy', unit: 'kWh', scale: 0.01 },
  reverse_energy_total: { key: 'reverse_energy', unit: 'kWh', scale: 0.01 },
  energy_forward:   { key: 'energy',  unit: 'kWh', scale: 0.01 },
  frequency:        { key: 'frequency', unit: 'Hz', scale: 0.01 },
  cur_frequency:    { key: 'frequency', unit: 'Hz', scale: 0.01 },
  power_factor:     { key: 'power_factor', unit: '',  scale: 0.01 },
};

// Some 3-phase clamp meters pack a per-phase payload as a base64-encoded
// blob under a single code like `phase_a` / `phase_b` / `phase_c`.
// Layout (big-endian): voltage(2B, 0.1V) | current(3B, mA) | power(3B, W)
function decodePhaseBlob(value) {
  if (typeof value !== 'string') return null;
  let buf;
  try { buf = Buffer.from(value, 'base64'); } catch { return null; }
  if (buf.length < 8) return null;
  const voltage = buf.readUInt16BE(0) / 10;
  const current = ((buf[2] << 16) | (buf[3] << 8) | buf[4]) / 1000;
  const power   = ((buf[5] << 16) | (buf[6] << 8) | buf[7]);
  return { voltage, current, power };
}

function normalize(deviceMeta, statusArray) {
  const out = {
    id: deviceMeta.id,
    label: deviceMeta.label,
    online: deviceMeta.online ?? true,
    name: deviceMeta.name,
    updatedAt: Date.now(),
    metrics: {},
    phases: {},
    extra: {},
  };

  for (const { code, value } of statusArray || []) {
    if (SCALAR_METRICS[code]) {
      const m = SCALAR_METRICS[code];
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(num)) {
        out.metrics[m.key] = { value: num * m.scale, unit: m.unit };
      }
      continue;
    }
    if (/^phase_[abc]$/i.test(code)) {
      const phase = code.slice(-1).toUpperCase();
      const decoded = decodePhaseBlob(value);
      if (decoded) out.phases[phase] = decoded;
      continue;
    }
    out.extra[code] = value;
  }

  // Synthesize aggregate power if device only reports per-phase.
  if (!out.metrics.power && Object.keys(out.phases).length) {
    const total = Object.values(out.phases).reduce((s, p) => s + (p.power || 0), 0);
    if (total > 0) out.metrics.power = { value: total, unit: 'W' };
  }

  return out;
}

module.exports = { normalize };
