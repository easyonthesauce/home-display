const fs = require('fs');

// Persistent tallies that drive the kitchen leaderboards and the vibe trend.
// Deliberately simple: a JSON file, rewritten on each update. Household-scale
// data, so no database needed.
function createStore({ file }) {
  let data = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.people = parsed.people || {};
      parsed.vibe = parsed.vibe || [];
      return parsed;
    } catch {
      return { people: {}, vibe: [], updatedAt: 0 };
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(data)); }
      catch (e) { console.warn(`[state] save failed: ${e.message}`); }
    }, 200);
  }

  function person(name) {
    if (!data.people[name]) {
      data.people[name] = {
        name, effortSum: 0, effortCount: 0,
        recognitions: 0, offenses: 0, appearances: 0, lastSeen: 0,
      };
    }
    return data.people[name];
  }

  const isRealName = (n) => n && !/^(unknown|person|someone|unidentified)/i.test(n.trim());

  function applyScene(scene) {
    for (const p of scene.people || []) {
      if (!isRealName(p.identity)) continue;
      const rec = person(p.identity.trim());
      if (typeof p.effort === 'number') { rec.effortSum += p.effort; rec.effortCount += 1; }
      rec.appearances += 1;
      rec.lastSeen = Date.now();
    }
    if (scene.vibe && typeof scene.vibe.score === 'number') {
      data.vibe.push({ t: Date.now(), score: scene.vibe.score, label: scene.vibe.label || '' });
      if (data.vibe.length > 500) data.vibe.shift();
    }
    data.updatedAt = Date.now();
    save();
  }

  // incident: { offenders: [names], recognized: [names] }
  function applyIncident(incident) {
    for (const n of incident.offenders || []) if (isRealName(n)) person(n.trim()).offenses += 1;
    for (const n of incident.recognized || []) if (isRealName(n)) person(n.trim()).recognitions += 1;
    data.updatedAt = Date.now();
    save();
  }

  function leaderboards() {
    const withAvg = Object.values(data.people).map((p) => ({
      ...p,
      avgEffort: p.effortCount ? Math.round(p.effortSum / p.effortCount) : 0,
    }));
    return {
      shame: withAvg.filter((p) => p.offenses > 0).sort((a, b) => b.offenses - a.offenses).slice(0, 5),
      effort: withAvg.filter((p) => p.effortCount > 0).sort((a, b) => b.avgEffort - a.avgEffort).slice(0, 5),
      recognition: withAvg.filter((p) => p.recognitions > 0).sort((a, b) => b.recognitions - a.recognitions).slice(0, 5),
    };
  }

  function snapshot() {
    return {
      vibe: data.vibe.slice(-120),
      leaderboards: leaderboards(),
      updatedAt: data.updatedAt,
    };
  }

  return { applyScene, applyIncident, leaderboards, snapshot };
}

module.exports = { createStore };
