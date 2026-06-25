(() => {
  const grid = document.getElementById('device-grid');
  const tpl = document.getElementById('device-tpl');
  const connDot = document.getElementById('conn-dot');
  const statusText = document.getElementById('status-text');
  const totalPowerEl = document.getElementById('total-power');
  const totalEnergyEl = document.getElementById('total-energy');
  const totalBar = document.getElementById('total-bar');
  const clockEl = document.getElementById('clock');
  const fsBtn = document.getElementById('fullscreen-btn');

  // Heuristic upper bound for the hero bar; auto-grows so spikes still look meaningful.
  let powerCeiling = 1500;

  const cards = new Map();          // deviceId -> { root, animators }
  const animState = new Map();      // key -> { current, target }

  // Smooth number tween via rAF. Each metric DOM node gets a unique anim key.
  function setAnimated(key, target, fmt, el) {
    let s = animState.get(key);
    if (!s) {
      s = { current: target, target, el, fmt };
      animState.set(key, s);
      el.textContent = fmt(target);
      return;
    }
    s.target = target;
    s.el = el;
    s.fmt = fmt;
  }
  function tickAnim() {
    for (const s of animState.values()) {
      if (Math.abs(s.target - s.current) < 0.01) {
        if (s.current !== s.target) {
          s.current = s.target;
          s.el.textContent = s.fmt(s.current);
        }
        continue;
      }
      s.current += (s.target - s.current) * 0.18;
      s.el.textContent = s.fmt(s.current);
    }
    requestAnimationFrame(tickAnim);
  }
  requestAnimationFrame(tickAnim);

  const fmtInt = (n) => Math.round(n).toLocaleString();
  const fmt1 = (n) => n.toFixed(1);
  const fmt2 = (n) => n.toFixed(2);
  const fmtPower = (n) => (n >= 1000 ? (n / 1000).toFixed(2) : Math.round(n).toString());

  function ensureCard(device) {
    let entry = cards.get(device.id);
    if (entry) return entry;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = device.id;
    node.querySelector('.card__title').textContent = device.label || device.name || device.id;

    // Give each card's gradient a unique id so multiple gauges can coexist
    const grad = node.querySelector('.gauge__grad');
    const gid = `g-${device.id.replace(/[^a-z0-9]/gi, '')}`;
    grad.id = gid;
    node.querySelector('.gauge__fill').setAttribute('stroke', `url(#${gid})`);

    grid.appendChild(node);
    entry = { root: node };
    cards.set(device.id, entry);
    return entry;
  }

  function setGauge(node, pct, level) {
    const fill = node.querySelector('.gauge__fill');
    const dasharray = 462;
    const clamped = Math.max(0, Math.min(1, pct));
    fill.style.strokeDashoffset = String(dasharray * (1 - clamped));

    // Color shift with load
    const grad = node.querySelector('.gauge__grad');
    const stops = grad.querySelectorAll('stop');
    if (level === 'high')   { stops[0].setAttribute('stop-color', '#fbbf24'); stops[1].setAttribute('stop-color', '#f87171'); }
    else if (level === 'mid'){ stops[0].setAttribute('stop-color', '#22d3ee'); stops[1].setAttribute('stop-color', '#a855f7'); }
    else                    { stops[0].setAttribute('stop-color', '#34d399'); stops[1].setAttribute('stop-color', '#22d3ee'); }
  }

  function levelFor(power, ceiling) {
    const r = power / ceiling;
    if (r > 0.75) return 'high';
    if (r > 0.3)  return 'mid';
    return 'low';
  }

  function renderPhases(node, phases) {
    const wrap = node.querySelector('.card__phases');
    const keys = Object.keys(phases || {});
    if (!keys.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = keys.sort().map((k) => {
      const p = phases[k];
      return `<div class="phase">
        <span class="phase__label">L${k}</span>
        <span class="phase__value">${Math.round(p.power)} W</span>
      </div>`;
    }).join('');
  }

  function renderDevice(device) {
    const { root } = ensureCard(device);
    const power = device.metrics?.power?.value ?? 0;

    root.classList.toggle('offline', !device.online);
    root.classList.toggle('live', device.online && power > 5);

    const ts = root.querySelector('.card__ts');
    const age = Math.max(0, Math.round((Date.now() - device.updatedAt) / 1000));
    ts.textContent = device.error ? 'error' : `${age}s ago`;

    // Per-card ceiling auto-scales to peak seen
    let cardCeiling = Number(root.dataset.ceiling || 2000);
    if (power > cardCeiling) cardCeiling = power * 1.2;
    root.dataset.ceiling = cardCeiling;

    setGauge(root, power / cardCeiling, levelFor(power, cardCeiling));
    setAnimated(`${device.id}:gauge`, power, fmtPower, root.querySelector('.gauge__value'));
    root.querySelector('.gauge__unit').textContent = power >= 1000 ? 'kW' : 'W';

    const v = device.metrics?.voltage?.value;
    const c = device.metrics?.current?.value;
    const e = device.metrics?.energy?.value;
    setAnimated(`${device.id}:v`, v ?? 0, (n) => v == null ? '—' : fmt1(n), root.querySelector('[data-metric=voltage]'));
    setAnimated(`${device.id}:c`, c ?? 0, (n) => c == null ? '—' : fmt2(n), root.querySelector('[data-metric=current]'));
    setAnimated(`${device.id}:e`, e ?? 0, (n) => e == null ? '—' : fmt2(n), root.querySelector('[data-metric=energy]'));

    renderPhases(root, device.phases);

    const dpsRaw = device.extra?.dpsRaw;
    if (dpsRaw) {
      const pre = root.querySelector('.card__dps');
      if (pre) pre.textContent = JSON.stringify(dpsRaw, null, 2);
    }
  }

  function renderSnapshot(snap) {
    const totalPower = snap.devices.reduce((s, d) => s + (d.metrics?.power?.value || 0), 0);
    const totalEnergy = snap.devices.reduce((s, d) => s + (d.metrics?.energy?.value || 0), 0);

    if (totalPower > powerCeiling) powerCeiling = totalPower * 1.15;
    setAnimated('total:power', totalPower, fmtInt, totalPowerEl);
    totalEnergyEl.textContent = `${totalEnergy.toFixed(2)} kWh total`;
    totalBar.style.width = `${Math.min(100, (totalPower / powerCeiling) * 100)}%`;

    // Render in the order they arrived from the server
    const seen = new Set();
    for (const d of snap.devices) {
      seen.add(d.id);
      renderDevice(d);
    }
    for (const [id, entry] of cards) {
      if (!seen.has(id)) { entry.root.remove(); cards.delete(id); }
    }
  }

  // WebSocket with auto-reconnect
  let lastMsgAt = 0;
  let ws;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    statusText.textContent = 'connecting…';
    connDot.className = 'dot';
    ws.onopen = () => {
      connDot.className = 'dot live';
      statusText.textContent = 'live';
    };
    ws.onmessage = (ev) => {
      lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') renderSnapshot(msg);
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => {
      connDot.className = 'dot down';
      statusText.textContent = 'reconnecting…';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }
  connect();

  // Stale indicator if we haven't received an update in a while
  setInterval(() => {
    if (!lastMsgAt) return;
    const age = Date.now() - lastMsgAt;
    if (age > 8000 && connDot.classList.contains('live')) {
      connDot.className = 'dot stale';
      statusText.textContent = `last update ${Math.round(age / 1000)}s ago`;
    }
  }, 1000);

  // Clock
  function updateClock() {
    const d = new Date();
    clockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  updateClock();
  setInterval(updateClock, 15_000);

  // Fullscreen toggle
  fsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') fsBtn.click();
  });
})();
