const { EventEmitter } = require('events');

// Central event bus. Every emitted event is (a) delivered to in-process
// listeners, (b) broadcast to all connected WebSocket dashboards, and
// (c) POSTed to any configured webhook URLs.
function createEventBus({ webhooks = [] } = {}) {
  const bus = new EventEmitter();
  const wsClients = new Set();

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(data); } catch { /* ignore */ }
      }
    }
  }

  async function dispatchWebhooks(message) {
    if (!webhooks.length) return;
    const body = JSON.stringify(message);
    await Promise.all(webhooks.map(async (url) => {
      try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      } catch (e) {
        console.warn(`[webhook] ${url}: ${e.message}`);
      }
    }));
  }

  function emit(type, payload) {
    const message = { type, payload, at: Date.now() };
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
