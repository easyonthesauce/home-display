const net = require('net');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const log = createLogger('smtp');

// A deliberately fake SMTP server. A consumer NVR / camera system configured to
// "email on motion" will open an SMTP conversation with us; we speak just enough
// of the protocol to make it hand over the message, then emit a `trigger` event
// instead of delivering any mail. Nothing is ever relayed or stored as email.
//
// We advertise no STARTTLS and accept any AUTH, because NVRs vary wildly. Set the
// camera's SMTP mode to "no encryption" and point it at this host:port.
function createSmtpTrigger({ port, bind, hostname }) {
  const emitter = new EventEmitter();

  const server = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`connection from ${peer}`);
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let dataLines = [];
    let authStep = null;                 // null | 'user' | 'pass'
    const session = { from: null, to: [] };

    const write = (line) => {
      log.debug(`${peer} <- ${line}`);
      try { socket.write(line + '\r\n'); } catch { /* closed */ }
    };
    write(`220 ${hostname} ESMTP watchtower`);

    function finishData() {
      inData = false;
      const raw = dataLines.join('\n');
      const subject = ((raw.match(/^subject:\s*(.*)$/im) || [])[1] || '').trim();
      dataLines = [];
      write('250 2.0.0 Ok: queued as trigger');
      log.info(`${peer} completed DATA: from=${session.from} to=[${session.to.join(', ')}] subject="${subject}"`);
      emitter.emit('trigger', {
        from: session.from,
        to: session.to.slice(),
        subject,
        raw,
        remote: socket.remoteAddress,
        at: Date.now(),
      });
    }

    function handleLine(line) {
      if (!inData) log.debug(`${peer} -> ${line}`);
      if (inData) {
        if (line === '.') return finishData();
        // SMTP dot-stuffing: a leading '.' on a body line is doubled.
        dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      if (authStep) {
        // We don't validate credentials — this isn't a real mail server.
        if (authStep === 'user') { authStep = 'pass'; return write('334 UGFzc3dvcmQ6'); }
        authStep = null;
        return write('235 2.7.0 Authentication successful');
      }

      const parts = line.split(' ');
      const cmd = (parts[0] || '').toUpperCase();
      const arg = parts.slice(1).join(' ');

      switch (cmd) {
        case 'EHLO':
          write(`250-${hostname} greets you`);
          write('250-AUTH LOGIN PLAIN');
          write('250-8BITMIME');
          write('250 SMTPUTF8');
          break;
        case 'HELO':
          write(`250 ${hostname}`);
          break;
        case 'AUTH': {
          const method = (parts[1] || '').toUpperCase();
          if (method === 'LOGIN') { authStep = 'user'; return write('334 VXNlcm5hbWU6'); }
          return write('235 2.7.0 Authentication successful');   // PLAIN or unknown
        }
        case 'MAIL':
          session.from = extractAddr(arg);
          write('250 2.1.0 Ok');
          break;
        case 'RCPT':
          session.to.push(extractAddr(arg));
          write('250 2.1.5 Ok');
          break;
        case 'DATA':
          inData = true; dataLines = [];
          write('354 End data with <CR><LF>.<CR><LF>');
          break;
        case 'RSET':
          session.from = null; session.to = [];
          write('250 2.0.0 Ok');
          break;
        case 'NOOP':
          write('250 2.0.0 Ok');
          break;
        case 'STARTTLS':
          write('454 4.7.0 TLS not available, continue unencrypted');
          break;
        case 'QUIT':
          write('221 2.0.0 Bye');
          socket.end();
          break;
        default:
          write('250 2.0.0 Ok');   // stay permissive with quirky NVR chatter
      }
    }

    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(line);
      }
    });
    socket.on('close', () => log.debug(`${peer} disconnected`));
    socket.on('error', (err) => log.debug(`${peer} socket error: ${err.message}`)); // NVRs love to drop connections abruptly
  });

  server.on('error', (err) => emitter.emit('error', err));
  server.listen(port, bind, () => emitter.emit('listening', { port, bind }));
  emitter.close = () => server.close();
  return emitter;
}

function extractAddr(s) {
  const m = String(s || '').match(/<([^>]*)>/);
  if (m) return m[1];
  const colon = String(s || '').split(':');
  return (colon[1] || colon[0] || '').trim();
}

module.exports = { createSmtpTrigger };
