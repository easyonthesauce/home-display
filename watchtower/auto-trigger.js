const { createLogger } = require('./logger');

const log = createLogger('auto-trigger');

// Per-camera scheduler for periodic "auto" motion triggers, independent of the
// SMTP/manual triggers. Each camera gets its own self-rescheduling timer so
// intervals can be changed per-camera at runtime (via the dashboard or the
// HTTP API) without restarting the process or disturbing other cameras.
function createAutoTriggerScheduler({ cameras, minSeconds, fire }) {
  // cameraId -> { seconds, timer, nextAt }
  const state = new Map();

  function clear(cameraId) {
    const entry = state.get(cameraId);
    if (entry && entry.timer) clearTimeout(entry.timer);
  }

  function scheduleNext(cameraId, seconds) {
    clear(cameraId);
    if (!seconds || seconds <= 0) {
      state.set(cameraId, { seconds: 0, timer: null, nextAt: null });
      return;
    }
    const nextAt = Date.now() + seconds * 1000;
    const timer = setTimeout(() => runNow(cameraId), seconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    state.set(cameraId, { seconds, timer, nextAt });
  }

  function runNow(cameraId) {
    const entry = state.get(cameraId);
    const seconds = entry ? entry.seconds : 0;
    log.info(`auto-trigger firing for "${cameraId}" (every ${seconds}s)`);
    try {
      fire(cameraId);
    } catch (e) {
      log.error(`auto-trigger fire() threw for "${cameraId}": ${e.message}`);
    }
    // Re-arm regardless of whether the current interval changed mid-flight —
    // set() below always wins if the user adjusted it while this fired.
    if (state.get(cameraId) && state.get(cameraId).seconds === seconds) {
      scheduleNext(cameraId, seconds);
    }
  }

  // Set (or disable, with seconds <= 0) the interval for one camera.
  // Values between 0 and minSeconds are clamped up to minSeconds so a typo
  // can't hammer the camera and burn API calls every few seconds.
  function set(cameraId, seconds) {
    const clamped = seconds > 0 ? Math.max(minSeconds, Math.round(seconds)) : 0;
    if (clamped !== seconds && seconds > 0) {
      log.warn(`requested auto-trigger interval ${seconds}s for "${cameraId}" is below the ${minSeconds}s minimum — clamped`);
    }
    log.info(`auto-trigger for "${cameraId}" set to ${clamped > 0 ? `every ${clamped}s` : 'off'}`);
    scheduleNext(cameraId, clamped);
    return clamped;
  }

  function get(cameraId) {
    const entry = state.get(cameraId) || { seconds: 0, nextAt: null };
    return { cameraId, seconds: entry.seconds, nextAt: entry.nextAt };
  }

  function list() {
    return cameras.map((c) => get(c.id));
  }

  function stopAll() {
    for (const id of state.keys()) clear(id);
  }

  // Initialise from each camera's configured default.
  for (const cam of cameras) {
    if (cam.autoTriggerSeconds > 0) {
      log.info(`auto-trigger initialised for "${cam.id}": every ${cam.autoTriggerSeconds}s`);
    }
    scheduleNext(cam.id, cam.autoTriggerSeconds || 0);
  }

  return { set, get, list, stopAll };
}

module.exports = { createAutoTriggerScheduler };
