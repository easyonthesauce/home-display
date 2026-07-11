const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

// Central event bus. Every emitted event is (a) delivered to in-process
// listeners, (b) broadcast to all connected WebSocket dashboards, and
// (c) POSTed to any configured webhook URLs.
function createEventBus({ webhooks = [], log = createLogger('events') } = {}) {
  const bus = new EventEmitter();
  const wsClients = new Set();

  function broadcast(message) {
    let sent = 0;
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify(message)); sent += 1; } catch (e) {
          log.warn(`failed to send to a dashboard client: ${e.message}`);
        }
      }
    }
    log.debug(`broadcast "${message.type}" to ${sent}/${wsClients.size} client(s)`);
  }

  async function dispatchWebhooks(message) {
    if (!webhooks.length) return;
    const body = JSON.stringify(message);
    await Promise.all(webhooks.map(async (url) => {
      const start = Date.now();
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        log.debug(`webhook ${url} → ${res.status} for "${message.type}" in ${Date.now() - start}ms`);
      } catch (e) {
        log.warn(`webhook ${url} failed for "${message.type}": ${e.message}`);
      }
    }));
  }

  function emit(type, payload) {
    const message = { type, payload, at: Date.now() };
    log.debug(`emit "${type}"`);
    bus.emit(type, payload);
    bus.emit('*', message);
    broadcast(message);
    dispatchWebhooks(message);
    return message;
  }

  return {
    on: (type, fn) => bus.on(type, fn),
    emit,
    broadcast,
    addClient: (ws) => wsClients.add(ws),
    removeClient: (ws) => wsClients.delete(ws),
    clientCount: () => wsClients.size,
  };
}

module.exports = { createEventBus };
