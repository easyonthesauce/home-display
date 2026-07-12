const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createLogger } = require('./logger');

const log = createLogger('diary');

// Local record of every entry — the source of truth for the dashboard's own
// "recent entries" list, so it never has to round-trip to Drive to render.
// A household-scale JSON file is plenty, same as water.json/faces.json.
function createDiaryStore({ file }) {
  let data = load();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      parsed.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      return parsed;
    } catch {
      return { entries: [] };
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
      catch (e) { log.error(`save failed: ${e.message}`); }
    }, 150);
  }

  function add(entry) {
    const record = { id: crypto.randomBytes(5).toString('hex'), ...entry };
    data.entries.unshift(record);
    if (data.entries.length > 5000) data.entries = data.entries.slice(0, 5000);
    save();
    return record;
  }

  function list(limit) {
    return limit ? data.entries.slice(0, limit) : data.entries.slice();
  }

  return { add, list, count: () => data.entries.length };
}

function bufferToStream(buffer) {
  const r = new Readable();
  r.push(buffer);
  r.push(null);
  return r;
}

// Thin wrapper around the Drive v3 API for uploading entries + keeping a
// manifest file up to date. Uses a service account with the narrow
// `drive.file` scope — it only ever touches the one folder the household
// shares with it, and only files it created itself. Returns null (not a
// client) when Drive isn't configured, so callers can fall back to
// local-only recording instead of failing every upload.
function createDriveClient({ serviceAccountJson, folderId }) {
  if (!serviceAccountJson || !folderId) return null;

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch (e) {
    log.error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
    return null;
  }

  // Lazy-required so the dependency is only needed when Drive is configured.
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });

  async function upload({ filename, mimeType, buffer }) {
    const res = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType, body: bufferToStream(buffer) },
      fields: 'id, webViewLink',
    });
    return res.data;
  }

  async function findFileByName(name) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });
    return (res.data.files || [])[0] || null;
  }

  // Overwrites (or creates) the manifest file listing every known entry, so
  // anyone browsing the Drive folder directly can see what's there without
  // opening the dashboard.
  async function writeIndex(name, entries) {
    const body = JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2);
    const media = { mimeType: 'application/json', body: bufferToStream(Buffer.from(body)) };
    const existing = await findFileByName(name);
    if (existing) {
      await drive.files.update({ fileId: existing.id, media, fields: 'id' });
      return existing.id;
    }
    const created = await drive.files.create({
      requestBody: { name, parents: [folderId] }, media, fields: 'id',
    });
    return created.data.id;
  }

  return { upload, writeIndex };
}

module.exports = { createDiaryStore, createDriveClient };
