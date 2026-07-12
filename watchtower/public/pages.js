// Lightweight page carousel for the kitchen display: shows one .page at a time,
// lets the user pick one via nav dots, and — when left idle — rotates through
// them automatically. Any interaction pauses rotation and keeps the current
// page up until things go quiet again.
(() => {
  const ROTATE_MS = 12000;   // advance every 12s once idle
  const IDLE_MS = 25000;     // ...but only after 25s of no interaction

  const container = document.getElementById('pages');
  const nav = document.getElementById('page-nav');
  if (!container || !nav) return;

  let pages = [];
  let current = 0;
  let lastInteraction = Date.now();

  function collect() {
    pages = Array.from(container.querySelectorAll('.page[data-page]'))
      .filter((p) => p.dataset.disabled !== 'true');
    if (current >= pages.length) current = 0;
  }

  function show(i) {
    if (!pages.length) return;
    current = (i + pages.length) % pages.length;
    pages.forEach((p, idx) => {
      const active = idx === current;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
    nav.querySelectorAll('.page-dot').forEach((d, idx) => d.classList.toggle('on', idx === current));
  }

  function buildNav() {
    nav.innerHTML = '';
    nav.hidden = pages.length <= 1;
    pages.forEach((p, idx) => {
      const dot = document.createElement('button');
      dot.className = 'page-dot' + (idx === current ? ' on' : '');
      dot.title = p.dataset.page;
      dot.addEventListener('click', () => { touch(); show(idx); });
      nav.appendChild(dot);
    });
  }

  function rebuild() {
    collect();
    buildNav();
    show(current);
  }

  function touch() { lastInteraction = Date.now(); }

  // Idle rotation
  setInterval(() => {
    if (pages.length <= 1) return;
    if (Date.now() - lastInteraction > IDLE_MS) show(current + 1);
  }, ROTATE_MS);

  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
    window.addEventListener(ev, touch, { passive: true }));

  // Let other scripts jump to a page by name (e.g. surface raised voices).
  window.watchtowerShowPage = (name) => {
    const idx = pages.findIndex((p) => p.dataset.page === name);
    if (idx >= 0) { touch(); show(idx); }
  };
  // Pages can appear/disappear at runtime (e.g. water page when disabled).
  window.addEventListener('pages:changed', rebuild);

  rebuild();
})();
