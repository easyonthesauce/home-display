const { createLogger } = require('./logger');

const log = createLogger('alerts');

function getPath(obj, path) {
  return path.split('.').reduce((v, key) => (v == null ? v : v[key]), obj);
}

// Render a value for use in a message template. Arrays of objects (e.g.
// environment_risks: [{risk, severity}]) are reduced to their most
// human-readable field rather than dumping raw JSON into a spoken sentence.
function stringifyValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.risk || item.name || item.identity || item.label || JSON.stringify(item);
      return String(item);
    }).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Fill {{field}} / {{nested.field}} placeholders from the event payload.
function renderTemplate(template, payload) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => stringifyValue(getPath(payload, path)));
}

// A single condition can be: an array (value must be one of these, case-
// insensitive for strings), an object with gte/lte/eq/neq, or a primitive
// (exact equality).
function matchesCondition(value, condition) {
  if (Array.isArray(condition)) {
    return condition.some((c) => (
      typeof value === 'string' && typeof c === 'string'
        ? value.toLowerCase() === c.toLowerCase()
        : value === c
    ));
  }
  if (condition && typeof condition === 'object') {
    if (condition.gte !== undefined && !(Number(value) >= condition.gte)) return false;
    if (condition.lte !== undefined && !(Number(value) <= condition.lte)) return false;
    if (condition.eq !== undefined && value !== condition.eq) return false;
    if (condition.neq !== undefined && value === condition.neq) return false;
    return true;
  }
  return value === condition;
}

function matchesWhen(payload, when) {
  if (!when) return true;
  return Object.entries(when).every(([path, condition]) => matchesCondition(getPath(payload, path), condition));
}

// Wires the configured alert rules to the event bus: on every bus event,
// find rules whose `event` matches, whose optional `when` conditions match
// the payload, and that aren't still in cooldown, then render the message
// template and fire it through the Alexa client.
function createAlertRouter({ config, bus, alexaClient }) {
  const { rules, device: defaultDevice, cooldownSeconds: defaultCooldown, enabled } = config.alerts;
  const lastFired = new Map(); // rule.id -> timestamp

  if (!enabled) {
    log.info('Alexa alerts disabled (WATCH_ALERTS / ALEXA_ALERTS_ENABLED)');
    return { rules: [] };
  }
  if (!rules.length) {
    log.info('Alexa alerts enabled but no rules configured — see alerts.json.example');
    return { rules: [] };
  }

  log.info(`Alexa alerts armed: ${rules.length} rule(s) → ${config.alexa.url}`);

  bus.on('*', (message) => {
    const matching = rules.filter((r) => r.event === message.type);
    if (!matching.length) return;

    for (const rule of matching) {
      if (rule.enabled === false) continue;
      if (!matchesWhen(message.payload, rule.when)) {
        log.debug(`rule "${rule.id}" matched event "${message.type}" but "when" conditions failed`);
        continue;
      }

      const cooldownMs = (rule.cooldownSeconds ?? defaultCooldown) * 1000;
      const last = lastFired.get(rule.id) || 0;
      if (Date.now() - last < cooldownMs) {
        log.debug(`rule "${rule.id}" fired but is in cooldown (${Math.round((cooldownMs - (Date.now() - last)) / 1000)}s remaining)`);
        continue;
      }

      const message_ = renderTemplate(rule.message, message.payload);
      const device = rule.device || defaultDevice;
      lastFired.set(rule.id, Date.now());
      log.info(`rule "${rule.id}" triggered by "${message.type}" → announcing to "${device}": "${message_}"`);

      alexaClient.announce(message_, device)
        .then(() => bus.emit('alexa.announced', { rule: rule.id, device, message: message_ }))
        .catch((e) => bus.emit('alexa.error', { rule: rule.id, device, message: message_, error: e.message }));
    }
  });

  return { rules };
}

module.exports = { createAlertRouter, renderTemplate, matchesWhen };
