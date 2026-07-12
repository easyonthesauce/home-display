// Water Challenge page: swimlanes with a filling water-droplet per participant,
// a period selector, the big central Drink button (which runs the ESP32 pump),
// and a leaderboard. Live pour progress and totals arrive over the shared
// WebSocket (via window.watchtowerSubscribe).
(() => {
  const $ = (id) => document.getElementById(id);

  const page = document.querySelector('.page[data-page="water"]');
  const lanesEl = $('water-lanes');
  const laneTpl = $('lane-tpl');
  const periodsEl = $('water-periods');
  const boardEl = $('water-board');
  const drinkBtn = $('water-drink');
  const drinkMlEl = $('drink-ml');
  const hintEl = $('water-hint');

  let enabled = false;
  let period = '24h';
  let activeUserId = null;     // whose lane is selected (the drinker)
  let pouring = false;         // is a pour in progress
  let pourUserId = null;
  const lanes = new Map();     // id -> lane element

  const TREND = { up: '▲', down: '▼', flat: '―' };

  async function init() {
    let state;
    try { state = await (await fetch('/api/state')).json(); } catch { return; }
    enabled = state.water && state.water.enabled;
    if (!enabled) {
      if (page) { page.dataset.disabled = 'true'; page.remove(); }
      window.dispatchEvent(new Event('pages:changed'));
      return;
    }
    drinkBtn.addEventListener('click', onDrink);
    $('water-join').addEventListener('click', onJoin);
    if (window.watchtowerSubscribe) window.watchtowerSubscribe(onMessage);
    await refresh();
  }

  function onMessage(msg) {
    if (!enabled) return;
    switch (msg.type) {
      case 'water.changed': refresh(); break;
      case 'water.pour.start':
        pouring = true; pourUserId = msg.payload.userId;
        setDrinkState();
        break;
      case 'water.pour.progress':
        if (msg.payload.userId === pourUserId) drinkMlEl.textContent = `${msg.payload.ml} ml`;
        break;
      case 'water.dispensed':
        pouring = false; pourUserId = null;
        drinkMlEl.textContent = msg.payload.ml ? `+${msg.payload.ml} ml` : '';
        setTimeout(() => { drinkMlEl.textContent = ''; }, 3000);
        setDrinkState();
        break;
    }
  }

  async function refresh() {
    let data;
    try { data = await (await fetch(`/api/water?period=${encodeURIComponent(period)}`)).json(); }
    catch { return; }
    if (!data.enabled) return;
    pouring = Boolean(data.session);
    pourUserId = data.session ? data.session.userId : null;
    renderPeriods(data.periods, data.period.id);
    renderLanes(data.participants);
    renderBoard(data.leaderboard);
    setDrinkState();
  }

  function renderPeriods(periods, activeId) {
    if (periodsEl.childElementCount === periods.length) {
      // just update active state
      periodsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === activeId));
      return;
    }
    periodsEl.innerHTML = '';
    for (const p of periods) {
      const b = document.createElement('button');
      b.className = 'period-btn' + (p.id === activeId ? ' on' : '');
      b.dataset.id = p.id;
      b.textContent = p.label;
      b.addEventListener('click', () => { period = p.id; refresh(); });
      periodsEl.appendChild(b);
    }
  }

  function renderLanes(participants) {
    const seen = new Set();
    for (const p of participants) {
      seen.add(p.id);
      let lane = lanes.get(p.id);
      if (!lane) {
        lane = laneTpl.content.firstElementChild.cloneNode(true);
        lane.dataset.id = p.id;
        // unique clip id per lane so multiple droplets don't share a clip
        const clip = lane.querySelector('.lane__clip');
        const clipId = `drop-${p.id}`;
        clip.id = clipId;
        lane.querySelector('.lane__fillg').setAttribute('clip-path', `url(#${clipId})`);
        lane.addEventListener('click', () => selectUser(p.id));
        lanesEl.appendChild(lane);
        lanes.set(p.id, lane);
      }
      lane.querySelector('[data-f=name]').textContent = p.name;
      lane.querySelector('[data-f=total]').textContent = p.total.toLocaleString();
      lane.querySelector('[data-f=rank]').textContent = `#${p.rank}`;
      const trendEl = lane.querySelector('[data-f=trend]');
      trendEl.textContent = TREND[p.trend.dir] || '';
      trendEl.className = `lane__trend ${p.trend.dir}`;
      setFill(lane, p.fillPct);
      lane.classList.toggle('selected', p.id === activeUserId);
    }
    for (const [id, lane] of lanes) {
      if (!seen.has(id)) { lane.remove(); lanes.delete(id); }
    }
    // if the selected user vanished, clear selection
    if (activeUserId && !lanes.has(activeUserId)) activeUserId = null;
  }

  // Raise the water level inside the droplet. The clipped fill rect's top edge
  // sits at (1 - pct) of the droplet height; Chromium transitions the y/height.
  function setFill(lane, pct) {
    const rect = lane.querySelector('.lane__water');
    const top = 150 - Math.max(0, Math.min(1, pct)) * 150;
    rect.style.transition = 'y 0.8s ease, height 0.8s ease';
    rect.style.y = `${top}px`;
    rect.style.height = `${150 - top}px`;
    lane.querySelector('.lane__pct').textContent = `${Math.round(pct * 100)}%`;
  }

  function selectUser(id) {
    activeUserId = id;
    for (const [lid, lane] of lanes) lane.classList.toggle('selected', lid === id);
    setDrinkState();
  }

  function renderBoard(leaderboard) {
    if (!leaderboard.length) { boardEl.innerHTML = '<li class="board__empty">no sips logged yet</li>'; return; }
    boardEl.innerHTML = leaderboard.map((r) =>
      `<li>${escapeHtml(r.name)}<span>${r.total.toLocaleString()} ml ${TREND[r.trend.dir] || ''}</span></li>`).join('');
  }

  function setDrinkState() {
    if (pouring) {
      drinkBtn.disabled = false;
      drinkBtn.classList.add('pouring');
      drinkBtn.querySelector('.drink-btn__label').textContent = 'Stop';
      const name = lanes.get(pourUserId)?.querySelector('[data-f=name]')?.textContent;
      hintEl.textContent = name ? `pouring for ${name}…` : 'pouring…';
    } else {
      drinkBtn.classList.remove('pouring');
      drinkBtn.querySelector('.drink-btn__label').textContent = 'Drink';
      drinkBtn.disabled = !activeUserId;
      hintEl.textContent = activeUserId
        ? `ready for ${lanes.get(activeUserId)?.querySelector('[data-f=name]')?.textContent || 'you'} — press Drink`
        : 'tap your lane, then press Drink';
    }
  }

  async function onDrink() {
    if (pouring) {
      await post('/api/water/pour/stop');
      return;
    }
    if (!activeUserId) { flash('tap your lane first'); return; }
    const res = await post('/api/water/pour/start', { userId: activeUserId });
    if (res && res.ok === false) flash(res.error || 'could not start');
  }

  async function onJoin() {
    const name = prompt('Name to add to the water challenge:');
    if (!name || !name.trim()) return;
    const res = await post('/api/water/participants', { name: name.trim() });
    if (res && res.participant) { activeUserId = res.participant.id; }
    await refresh();
  }

  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json().catch(() => ({ ok: res.ok }));
    } catch (e) { flash(e.message); return null; }
  }

  function flash(text) { (window.watchtowerFlash || (() => {}))(`💧 ${text}`); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
