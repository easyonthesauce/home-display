const fs = require('fs');
const { createLogger } = require('./logger');

const log = createLogger('tasks');

const SCOPES = ['https://www.googleapis.com/auth/tasks'];

// Persists the OAuth2 refresh/access token pair to a small JSON file so the
// dashboard stays authorized across restarts. Household scale, same pattern
// as state.json/water.json — just one row, no locking needed.
function createTokenStore(file) {
  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  function save(tokens) {
    try { fs.writeFileSync(file, JSON.stringify(tokens, null, 2)); } catch (e) {
      log.error(`failed to persist Google Tasks tokens: ${e.message}`);
    }
  }
  function clear() {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
  return { load, save, clear };
}

// Thin wrapper around a Google OAuth2 client for the Tasks API. Tasks are
// per-user data, so (unlike Dear Diary's Drive service account) this needs an
// interactive one-time consent flow — visit the auth URL, sign in, and the
// refresh token gets stored locally from then on.
function createTasksAuth({ clientId, clientSecret, redirectUri, tokenFile }) {
  if (!clientId || !clientSecret) return null;

  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const tokenStore = createTokenStore(tokenFile);

  const saved = tokenStore.load();
  if (saved) oauth2Client.setCredentials(saved);

  // googleapis calls this whenever it refreshes the access token (or on the
  // initial exchange) — keep the file in sync so a fresh access token is
  // never lost on restart, even though only the refresh_token really matters.
  oauth2Client.on('tokens', (tokens) => {
    tokenStore.save({ ...(tokenStore.load() || {}), ...tokens });
  });

  function isAuthorized() {
    return Boolean(oauth2Client.credentials && oauth2Client.credentials.refresh_token);
  }

  function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',   // force a refresh_token even on repeat consent
      scope: SCOPES,
    });
  }

  async function handleCallback(code) {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    tokenStore.save({ ...(tokenStore.load() || {}), ...tokens });
    return tokens;
  }

  function signOut() {
    oauth2Client.setCredentials({});
    tokenStore.clear();
  }

  return { client: oauth2Client, isAuthorized, getAuthUrl, handleCallback, signOut };
}

function normalizeTask(t) {
  return {
    id: t.id,
    title: t.title || '(untitled)',
    notes: t.notes || '',
    due: t.due || null,
    completed: t.status === 'completed',
    completedAt: t.completed || null,
    position: t.position || '',
    updated: t.updated || null,
  };
}

// Thin wrapper around the Tasks v1 API — task lists are the "columns", tasks
// within them are the cards.
function createTasksClient(oauth2Client) {
  const { google } = require('googleapis');
  const tasks = google.tasks({ version: 'v1', auth: oauth2Client });

  async function listTaskLists() {
    const res = await tasks.tasklists.list({ maxResults: 100 });
    return res.data.items || [];
  }

  async function listTasks(tasklistId) {
    const res = await tasks.tasks.list({
      tasklist: tasklistId, showCompleted: true, showHidden: true, maxResults: 200,
    });
    return (res.data.items || []).filter((t) => !t.parent); // top-level cards only, no subtasks in the board
  }

  async function insertTask(tasklistId, { title, notes, due }) {
    const res = await tasks.tasks.insert({
      tasklist: tasklistId,
      requestBody: { title, notes: notes || undefined, due: due || undefined },
    });
    return res.data;
  }

  async function patchTask(tasklistId, taskId, patch) {
    const res = await tasks.tasks.patch({ tasklist: tasklistId, task: taskId, requestBody: patch });
    return res.data;
  }

  async function deleteTask(tasklistId, taskId) {
    await tasks.tasks.delete({ tasklist: tasklistId, task: taskId });
  }

  // Reorder within the same list — `previous` is the id of the task that
  // should now precede it (omit to move to the top).
  async function moveTask(tasklistId, taskId, { previous } = {}) {
    const res = await tasks.tasks.move({ tasklist: tasklistId, task: taskId, previous: previous || undefined });
    return res.data;
  }

  return { listTaskLists, listTasks, insertTask, patchTask, deleteTask, moveTask };
}

// Polls Google Tasks on an interval and keeps the latest board layout in
// memory, so every request (and every connected dashboard) reads from cache
// instead of hitting the API. Emits 'tasks.changed' when something actually
// changed, so clients only need to hold a WebSocket + this cache, not poll.
function createTasksCache({ client, pollMs, emit }) {
  let boards = [];
  let lastSyncAt = 0;
  let lastError = null;
  let timer = null;
  let lastJson = '';

  async function refresh() {
    try {
      const lists = await client.listTaskLists();
      const next = await Promise.all(lists.map(async (l) => ({
        id: l.id,
        title: l.title,
        tasks: (await client.listTasks(l.id)).map(normalizeTask),
      })));
      const nextJson = JSON.stringify(next);
      const changed = nextJson !== lastJson;
      boards = next;
      lastJson = nextJson;
      lastSyncAt = Date.now();
      lastError = null;
      if (changed && emit) emit('tasks.changed', { reason: 'sync' });
    } catch (e) {
      lastError = e.message;
      log.warn(`Google Tasks sync failed: ${e.message}`);
    }
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, refresh, snapshot: () => ({ boards, lastSyncAt, lastError }) };
}

// Tasks due today/overdue (or within dueSoonHours) across every list, for the
// central page's quick-view widget — overdue first, then soonest due.
function buildQuickView(boards, dueSoonHours, limit) {
  const cutoff = Date.now() + dueSoonHours * 3600 * 1000;
  const rows = [];
  for (const board of boards) {
    for (const t of board.tasks) {
      if (t.completed || !t.due) continue;
      const dueAt = Date.parse(t.due);
      if (Number.isNaN(dueAt) || dueAt > cutoff) continue;
      rows.push({ ...t, listId: board.id, listTitle: board.title, dueAt, overdue: dueAt < Date.now() });
    }
  }
  rows.sort((a, b) => a.dueAt - b.dueAt);
  return rows.slice(0, limit);
}

module.exports = { createTasksAuth, createTasksClient, createTasksCache, buildQuickView };
