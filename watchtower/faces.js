const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('faces');

const DESCRIPTOR_LENGTH = 128; // face-api's face_recognition_model output size

// Persistent store of *enrolled* face signatures. Nothing is written here
// unless a person explicitly consented to enrolment via the dashboard — the
// live "unknown face" detection that drives the "have we met?" prompt is
// ephemeral and never reaches this store. Signatures are 128-float descriptors
// (not images); they stay on this machine / LAN.
function createFaceStore({ file }) {
  let data = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.people = parsed.people || {};
      return parsed;
    } catch {
      return { people: {}, updatedAt: 0 };
    }
  }

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (e) {
      log.error(`save failed: ${e.message}`);
    }
  }

  function isValidDescriptor(d) {
    return Array.isArray(d) && d.length === DESCRIPTOR_LENGTH && d.every((n) => Number.isFinite(n));
  }

  function sanitizeDescriptors(descriptors) {
    if (!Array.isArray(descriptors)) return [];
    return descriptors.filter(isValidDescriptor).map((d) => d.map(Number));
  }

  // Public view for the dashboard: includes descriptors, since matching runs
  // client-side against the enrolled set. This is a LAN-local app.
  function list() {
    return Object.values(data.people).map((p) => ({
      id: p.id,
      name: p.name,
      enrolledAt: p.enrolledAt,
      updatedAt: p.updatedAt,
      sampleCount: p.descriptors.length,
      descriptors: p.descriptors,
    }));
  }

  // Roster view without biometric data — for logs / non-matching UI.
  function summary() {
    return Object.values(data.people).map((p) => ({
      id: p.id, name: p.name, enrolledAt: p.enrolledAt, sampleCount: p.descriptors.length,
    }));
  }

  function enroll({ name, descriptors, consent }) {
    if (!consent) throw new Error('enrolment requires explicit consent');
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('name is required');
    const clean = sanitizeDescriptors(descriptors);
    if (!clean.length) throw new Error(`need at least one valid ${DESCRIPTOR_LENGTH}-value face descriptor`);

    const id = crypto.randomBytes(6).toString('hex');
    data.people[id] = {
      id,
      name: cleanName,
      enrolledAt: Date.now(),
      updatedAt: Date.now(),
      descriptors: clean,
    };
    data.updatedAt = Date.now();
    save();
    log.info(`enrolled "${cleanName}" (${id}) with ${clean.length} sample(s)`);
    return summaryOf(id);
  }

  function addSamples(id, descriptors) {
    const person = data.people[id];
    if (!person) throw new Error(`unknown person "${id}"`);
    const clean = sanitizeDescriptors(descriptors);
    if (!clean.length) throw new Error('no valid descriptors provided');
    person.descriptors.push(...clean);
    // Cap stored samples per person so the file can't grow unbounded.
    if (person.descriptors.length > 20) person.descriptors = person.descriptors.slice(-20);
    person.updatedAt = Date.now();
    data.updatedAt = Date.now();
    save();
    log.info(`added ${clean.length} sample(s) to "${person.name}" (${id})`);
    return summaryOf(id);
  }

  function forget(id) {
    const person = data.people[id];
    if (!person) return false;
    delete data.people[id];
    data.updatedAt = Date.now();
    save();
    log.info(`forgot "${person.name}" (${id}) — signature deleted`);
    return true;
  }

  function summaryOf(id) {
    const p = data.people[id];
    return p ? { id: p.id, name: p.name, enrolledAt: p.enrolledAt, sampleCount: p.descriptors.length } : null;
  }

  // Server-side match helper (Euclidean distance to the nearest stored sample).
  // Mainly used by tests and the optional RTSP tie-in; the dashboard matches
  // client-side. Returns the best match under `threshold`, or null.
  function match(descriptor, threshold = 0.5) {
    if (!isValidDescriptor(descriptor)) return null;
    let best = null;
    for (const p of Object.values(data.people)) {
      for (const sample of p.descriptors) {
        const dist = euclidean(descriptor, sample);
        if (dist <= threshold && (!best || dist < best.distance)) {
          best = { id: p.id, name: p.name, distance: dist };
        }
      }
    }
    return best;
  }

  return { list, summary, enroll, addSamples, forget, match, count: () => Object.keys(data.people).length };
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

module.exports = { createFaceStore, euclidean, DESCRIPTOR_LENGTH };
