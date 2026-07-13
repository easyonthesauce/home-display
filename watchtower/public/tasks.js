// Google Tasks — a "due soon" quick view on the watch page, plus a
// dedicated Trello-style board page (one column per Google task list).
// Server does all the Google API talk (see watchtower/tasks.js); this just
// renders /api/tasks and posts card actions back.
(() => {
  const $ = (id) => document.getElementById(id);

  const quickSection = $('tasks-quickview');
  const quickConnect = $('tasks-quickview-connect');
  const quickConnectLink = $('tasks-quickview-connect-link');
  const quickList = $('tasks-quickview-list');

  const page = document.querySelector('.page[data-page="tasks"]');
  const boardConnect = $('tasks-connect');
  const boardConnectLink = $('tasks-connect-link');
  const boardEl = $('tasks-board');
  const syncEl = $('tasks-sync');

  let boards = [];
  let quickView = [];
  let authorized = false;
  let dragging = null; // { listId, taskId }

  function removeFeature() {
    if (quickSection) quickSection.remove();
    if (page) { page.dataset.disabled = 'true'; page.remove(); }
    window.dispatchEvent(new Event('pages:changed'));
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `request failed (${res.status})`);
    return body;
  }

  async function init() {
    let res;
    try {
      res = await fetch('/api/tasks');
    } catch { removeFeature(); return; }
    if (res.status === 404) { removeFeature(); return; }   // Tasks disabled server-side
    const data = await res.json().catch(() => ({}));
    if (quickSection) quickSection.hidden = false;
    applyData(data);
  }

  function applyData(data) {
    authorized = Boolean(data.authorized);
    boards = data.boards || [];
    quickView = data.quickView || [];

    if (!authorized) {
      if (quickConnect) { quickConnect.hidden = false; quickConnectLink.href = data.authUrl || '#'; }
      if (quickList) quickList.innerHTML = '';
      if (boardConnect) { boardConnect.hidden = false; boardConnectLink.href = data.authUrl || '#'; }
      if (boardEl) boardEl.innerHTML = '';
      if (syncEl) syncEl.textContent = '';
      return;
    }
    if (quickConnect) quickConnect.hidden = true;
    if (boardConnect) boardConnect.hidden = true;
    renderQuickView();
    renderBoard();
    if (syncEl) {
      syncEl.textContent = data.lastError
        ? `sync error: ${data.lastError}`
        : (data.lastSyncAt ? `synced ${relativeTime(data.lastSyncAt)}` : '');
    }
  }

  async function refresh() {
    try {
      const data = await api('/api/tasks');
      applyData(data);
    } catch { /* keep showing the last known state */ }
  }

  // ---------- due-date formatting ----------
  function dueLabel(iso, overdue) {
    if (!iso) return '';
    const due = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dueDay = new Date(due); dueDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dueDay - today) / 86400000);
    if (overdue || diffDays < 0) return diffDays === -1 ? 'overdue 1d' : `overdue ${Math.abs(diffDays)}d`;
    if (diffDays === 0) return 'due today';
    if (diffDays === 1) return 'due tomorrow';
    if (diffDays < 7) return due.toLocaleDateString([], { weekday: 'short' });
    return due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function relativeTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  // ---------- quick view (watch page) ----------
  function renderQuickView() {
    if (!quickList) return;
    if (!quickView.length) {
      quickList.innerHTML = '<li class="board__empty">nothing due soon 🎉</li>';
      return;
    }
    const tpl = $('tasks-quickview-item-tpl');
    quickList.innerHTML = '';
    for (const t of quickView) {
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.dataset.list = t.listId;
      el.dataset.task = t.id;
      el.querySelector('[data-f=title]').textContent = t.title;
      const due = el.querySelector('[data-f=due]');
      due.textContent = dueLabel(t.due, t.overdue);
      due.classList.toggle('overdue', Boolean(t.overdue));
      el.querySelector('[data-f=list]').textContent = t.listTitle;
      el.querySelector('[data-f=check]').addEventListener('click', () => toggleTask(t.listId, t.id, true));
      quickList.appendChild(el);
    }
  }

  async function toggleTask(listId, taskId, completed) {
    try {
      await api(`/api/tasks/${encodeURIComponent(listId)}/${encodeURIComponent(taskId)}/toggle`, {
        method: 'POST', body: JSON.stringify({ completed }),
      });
      window.watchtowerFlash?.(completed ? '✅ task completed' : 'task reopened');
      refresh();
    } catch (e) {
      window.watchtowerFlash?.(`couldn't update task: ${e.message}`);
    }
  }

  // ---------- board page ----------
  function renderBoard() {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    const colTpl = $('tasks-column-tpl');
    const cardTpl = $('tasks-card-tpl');

    for (const board of boards) {
      const col = colTpl.content.firstElementChild.cloneNode(true);
      col.dataset.list = board.id;
      col.querySelector('[data-f=title]').textContent = board.title;
      const active = board.tasks.filter((t) => !t.completed);
      col.querySelector('[data-f=count]').textContent = active.length;

      const cardsEl = col.querySelector('[data-f=cards]');
      for (const t of board.tasks) {
        const card = cardTpl.content.firstElementChild.cloneNode(true);
        card.dataset.list = board.id;
        card.dataset.task = t.id;
        card.classList.toggle('completed', t.completed);
        card.querySelector('[data-f=title]').textContent = t.title;
        const notesEl = card.querySelector('[data-f=notes]');
        if (t.notes) notesEl.textContent = t.notes; else notesEl.remove();
        const dueEl = card.querySelector('[data-f=due]');
        if (t.due) {
          dueEl.textContent = dueLabel(t.due, Date.parse(t.due) < Date.now() && !t.completed);
          dueEl.classList.toggle('overdue', Date.parse(t.due) < Date.now() && !t.completed);
        } else dueEl.remove();

        card.querySelector('[data-f=check]').addEventListener('click', () => toggleTask(board.id, t.id, !t.completed));
        card.querySelector('[data-f=del]').addEventListener('click', () => deleteTask(board.id, t.id));

        card.addEventListener('dragstart', (e) => {
          dragging = { listId: board.id, taskId: t.id };
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => { dragging = null; card.classList.remove('dragging'); });

        cardsEl.appendChild(card);
      }

      cardsEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = cardAfter(cardsEl, e.clientY);
        const draggedEl = cardsEl.querySelector('.dragging');
        if (!draggedEl) return;
        if (after == null) cardsEl.appendChild(draggedEl);
        else cardsEl.insertBefore(draggedEl, after);
      });
      cardsEl.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragging) return;
        const draggedEl = cardsEl.querySelector('.dragging');
        const previousEl = draggedEl && draggedEl.previousElementSibling;
        moveTask(dragging.listId, dragging.taskId, board.id, previousEl ? previousEl.dataset.task : null);
      });

      const addForm = col.querySelector('[data-f=add]');
      addForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = addForm.querySelector('input');
        addTask(board.id, input.value);
        input.value = '';
      });

      boardEl.appendChild(col);
    }
  }

  function cardAfter(container, y) {
    const cards = [...container.querySelectorAll('.task-card:not(.dragging)')];
    let closest = { offset: -Infinity, el: null };
    for (const el of cards) {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el };
    }
    return closest.el;
  }

  async function deleteTask(listId, taskId) {
    try {
      await api(`/api/tasks/${encodeURIComponent(listId)}/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      window.watchtowerFlash?.(`couldn't delete task: ${e.message}`);
      refresh();
    }
  }

  async function addTask(listId, title) {
    const clean = title.trim();
    if (!clean) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(listId)}`, { method: 'POST', body: JSON.stringify({ title: clean }) });
      refresh();
    } catch (e) {
      window.watchtowerFlash?.(`couldn't add task: ${e.message}`);
    }
  }

  async function moveTask(listId, taskId, toListId, previousTaskId) {
    try {
      await api(`/api/tasks/${encodeURIComponent(listId)}/${encodeURIComponent(taskId)}/move`, {
        method: 'POST', body: JSON.stringify({ toListId, previousTaskId }),
      });
      refresh();
    } catch (e) {
      window.watchtowerFlash?.(`couldn't move task: ${e.message}`);
      refresh();
    }
  }

  if (window.watchtowerSubscribe) {
    window.watchtowerSubscribe((msg) => { if (msg.type === 'tasks.changed') refresh(); });
  }

  init();
})();
