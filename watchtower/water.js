const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('water');

const DAY_MS = 24 * 60 * 60 * 1000;

// Selectable reporting windows for the water-challenge page.
const PERIODS = [
  { id: '24h', label: '24 hours', days: 1 },
  { id: 'week', label: 'This week', days: 7 },
  { id: 'month', label: 'This month', days: 30 },
  { id: '6mo', label: '6 months', days: 182 },
  { id: '12mo', label: '12 months', days: 365 },
];

function periodById(id) {
  return PERIODS.find((p) => p.id === id) || PERIODS[0];
}

// Store of challenge participants + timestamped consumption records (ml).
// Household scale, so a flat JSON file is plenty.
function createWaterStore({ file, dailyGoalMl }) {
  let data = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.participants = parsed.participants || {};
      parsed.records = parsed.records || [];
      return parsed;
    } catch {
      return { participants: {}, records: [], updatedAt: 0 };
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(data)); }
      catch (e) { log.error(`save failed: ${e.message}`); }
    }, 150);
  }

  function addParticipant(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('name is required');
    const existing = Object.values(data.participants)
      .find((p) => p.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) { existing.optedIn = true; save(); return existing; }
    const id = crypto.randomBytes(5).toString('hex');
    data.participants[id] = { id, name: cleanName, optedIn: true, joinedAt: Date.now() };
    data.updatedAt = Date.now();
    save();
    log.info(`"${cleanName}" (${id}) joined the water challenge`);
    return data.participants[id];
  }

  function setOptIn(id, optedIn) {
    const p = data.participants[id];
    if (!p) throw new Error(`unknown participant "${id}"`);
    p.optedIn = Boolean(optedIn);
    save();
    log.info(`"${p.name}" ${p.optedIn ? 'opted in to' : 'opted out of'} the water challenge`);
    return p;
  }

  function removeParticipant(id) {
    if (!data.participants[id]) return false;
    const name = data.participants[id].name;
    delete data.participants[id];
    save();
    log.info(`removed participant "${name}" (${id})`);
    return true;
  }

  function getParticipant(id) { return data.participants[id] || null; }

  function record(userId, ml) {
    if (!data.participants[userId]) throw new Error(`unknown participant "${userId}"`);
    const amount = Math.round(Number(ml));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('ml must be a positive number');
    data.records.push({ userId, ml: amount, at: Date.now() });
    if (data.records.length > 50000) data.records = data.records.slice(-50000);
    data.updatedAt = Date.now();
    save();
    return amount;
  }

  function sumBetween(userId, from, to) {
    let sum = 0;
    for (const r of data.records) {
      if (r.userId === userId && r.at >= from && r.at < to) sum += r.ml;
    }
    return sum;
  }

  // Computed view for one period: per-participant totals, goal-fill for the
  // droplet, rank, and trend vs the preceding equal-length window.
  function view(periodId) {
    const period = periodById(periodId);
    const now = Date.now();
    const windowMs = period.days * DAY_MS;
    const goalMl = dailyGoalMl * period.days;

    const opted = Object.values(data.participants).filter((p) => p.optedIn);
    const rows = opted.map((p) => {
      const total = sumBetween(p.id, now - windowMs, now);
      const prev = sumBetween(p.id, now - 2 * windowMs, now - windowMs);
      let dir = 'flat';
      if (total > prev * 1.05) dir = 'up';
      else if (total < prev * 0.95) dir = 'down';
      const pct = prev > 0 ? Math.round(((total - prev) / prev) * 100) : (total > 0 ? 100 : 0);
      return {
        id: p.id,
        name: p.name,
        total,
        goal: goalMl,
        fillPct: goalMl > 0 ? Math.min(1, total / goalMl) : 0,
        trend: { dir, pct },
      };
    });

    rows.sort((a, b) => b.total - a.total);
    rows.forEach((r, i) => { r.rank = i + 1; });

    return {
      period: { id: period.id, label: period.label, days: period.days },
      periods: PERIODS.map((p) => ({ id: p.id, label: p.label })),
      dailyGoalMl,
      participants: rows,
      leaderboard: rows.map((r) => ({ id: r.id, name: r.name, total: r.total, rank: r.rank, trend: r.trend })),
      totalMl: rows.reduce((s, r) => s + r.total, 0),
    };
  }

  function listParticipants() {
    return Object.values(data.participants).map((p) => ({ ...p }));
  }

  return {
    addParticipant, setOptIn, removeParticipant, getParticipant,
    record, view, listParticipants,
    count: () => Object.values(data.participants).filter((p) => p.optedIn).length,
  };
}

module.exports = { createWaterStore, PERIODS, periodById };
