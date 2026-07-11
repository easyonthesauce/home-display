// Small leveled, timestamped logger. Verbose/debug output is opt-in via
// WATCH_VERBOSE=1 or LOG_LEVEL=debug so normal runs stay quiet, but anyone
// debugging a flaky camera or a slow analysis call can turn it up.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (() => {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw && LEVELS[raw] !== undefined) return LEVELS[raw];
  return process.env.WATCH_VERBOSE === '1' ? LEVELS.debug : LEVELS.info;
})();

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmt(scope, level, args) {
  const prefix = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  return [prefix, ...args];
}

function createLogger(scope) {
  const log = (level, ...args) => {
    if (LEVELS[level] > configuredLevel) return;
    const line = fmt(scope, level, args);
    if (level === 'error') console.error(...line);
    else if (level === 'warn') console.warn(...line);
    else console.log(...line);
  };
  return {
    error: (...a) => log('error', ...a),
    warn: (...a) => log('warn', ...a),
    info: (...a) => log('info', ...a),
    debug: (...a) => log('debug', ...a),
    isDebug: () => configuredLevel >= LEVELS.debug,
  };
}

module.exports = { createLogger };
