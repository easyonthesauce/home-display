const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('water-pour');

// Orchestrates a single "pour": press Drink -> pump on -> flow accrues -> press
// Drink again (or a safety limit) -> pump off -> record ml for the drinker.
//
// Two safety nets, because this switches a real 12V pump:
//   1. Server-side max-volume and max-duration cutoffs (here).
//   2. Independent hardware cutoffs in the ESP32 firmware.
// If the ESP32 is unreachable/unconfigured, a simulated flow drives the same
// lifecycle so the game is fully usable without hardware.
function createPourManager({ config, store, esp32, emit }) {
  const { maxPourMl, maxPourSeconds, mockFlowMlPerSec } = config.water;
  let session = null;

  function snapshot() {
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      name: session.name,
      ml: Math.round(session.ml),
      startedAt: session.startedAt,
      mock: session.mock,
    };
  }

  function clearTimers() {
    if (session && session.safetyTimer) clearTimeout(session.safetyTimer);
    if (session && session.mockTimer) clearInterval(session.mockTimer);
  }

  async function start(userId) {
    if (session) throw new Error('a pour is already in progress');
    const participant = store.getParticipant(userId);
    if (!participant) throw new Error(`unknown participant "${userId}"`);
    if (!participant.optedIn) throw new Error(`${participant.name} is not opted in to the challenge`);

    const sessionId = crypto.randomBytes(6).toString('hex');
    session = {
      sessionId, userId, name: participant.name,
      startedAt: Date.now(), ml: 0,
      mock: !esp32.configured, finalizing: false,
      safetyTimer: null, mockTimer: null,
    };

    if (esp32.configured) {
      try {
        await esp32.pumpOn({ maxMl: maxPourMl, maxSeconds: maxPourSeconds });
      } catch (e) {
        session = null;
        throw new Error(`could not start pump: ${e.message}`);
      }
    } else {
      // Simulated flow: accrue ml at the configured rate until stopped/capped.
      session.mockTimer = setInterval(() => {
        if (!session) return;
        session.ml += mockFlowMlPerSec * 0.25;
        emitProgress();
        if (session.ml >= maxPourMl) stop('max-volume');
      }, 250);
    }

    // Server-side dead-man: always stop after maxPourSeconds no matter what.
    session.safetyTimer = setTimeout(() => stop('max-duration'), maxPourSeconds * 1000);

    log.info(`pour started for "${participant.name}" (${sessionId})${session.mock ? ' [mock]' : ''}`);
    emit('water.pour.start', { userId, name: participant.name, sessionId, mock: session.mock });
    return snapshot();
  }

  function emitProgress() {
    if (!session) return;
    emit('water.pour.progress', { userId: session.userId, sessionId: session.sessionId, ml: Math.round(session.ml) });
  }

  // ESP32 reports cumulative session flow (ml). Ignored if it doesn't match the
  // active session.
  function reportFlow(ml, sessionId) {
    if (!session) return { ok: false, error: 'no active pour' };
    if (sessionId && sessionId !== session.sessionId) return { ok: false, error: 'stale session' };
    const amount = Number(ml);
    if (Number.isFinite(amount) && amount >= session.ml) session.ml = amount;
    emitProgress();
    if (session.ml >= maxPourMl) stop('max-volume');
    return { ok: true, ml: Math.round(session.ml) };
  }

  async function stop(reason = 'user') {
    if (!session || session.finalizing) return null;
    session.finalizing = true;
    const active = session;
    clearTimers();

    if (esp32.configured) {
      try {
        const res = await esp32.pumpOff();
        if (res && Number.isFinite(Number(res.ml))) active.ml = Number(res.ml);
      } catch (e) {
        log.error(`pump-off command failed (${reason}): ${e.message} — firmware safety cutoff should still apply`);
      }
    }

    const ml = Math.round(active.ml);
    session = null;

    if (ml > 0) {
      try { store.record(active.userId, ml); } catch (e) { log.error(`record failed: ${e.message}`); }
    }
    log.info(`pour finished for "${active.name}": ${ml}ml (${reason})`);
    emit('water.dispensed', { userId: active.userId, name: active.name, ml, reason });
    return { userId: active.userId, name: active.name, ml, reason };
  }

  return { start, stop, reportFlow, snapshot, isActive: () => Boolean(session) };
}

module.exports = { createPourManager };
