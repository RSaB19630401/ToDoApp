/**
 * ToDoApp – API (Cloudflare Pages Function)
 * Läuft serverseitig auf Cloudflare (moderne JS-Syntax ist hier unproblematisch).
 *
 * Benötigt in den Pages-Einstellungen:
 *   Binding   DB                  -> D1-Datenbank
 *   Variable  ACCESS_TEAM_DOMAIN  -> z. B. "ralf.cloudflareaccess.com"
 *   Variable  ACCESS_AUD          -> "Application Audience (AUD) Tag" der Access-App
 *   Variable  ALLOWED_EMAILS      -> optional, kommagetrennt, z. B. "ralf@example.de"
 *
 * Für Push-Benachrichtigungen (Phase 2):
 *   Variable  VAPID_PUBLIC_KEY    -> öffentlicher VAPID-Schlüssel (base64url)
 *   Secret    VAPID_PRIVATE_JWK   -> privater VAPID-Schlüssel als JWK-JSON
 *   Variable  VAPID_SUBJECT       -> z. B. "mailto:ralf@example.de"
 *
 * Routen:
 *   GET    /api/bootstrap
 *   POST   /api/{tasks|lists|areas|categories}
 *   PATCH  /api/{tasks|lists|areas|categories}/{id}
 *   DELETE /api/{tasks|lists|areas|categories}/{id}
 *   GET    /api/settings            PUT /api/settings
 *   GET    /api/push/key
 *   POST   /api/push/subscribe      POST /api/push/unsubscribe      POST /api/push/test
 */

import { pushToOwner } from '../../lib/webpush.js';

const FIELDS = {
  lists: ['name', 'color', 'sort'],
  areas: ['name', 'color', 'sort'],
  categories: ['name', 'color', 'sort'],
  tasks: ['parent_id', 'list_id', 'area_id', 'category_id', 'title', 'notes',
    'urgency', 'importance', 'rated', 'due_date', 'due_time', 'recurrence', 'done', 'sort',
    'remind_offset', 'remind_at']
};

const RECUR_FREQ = ['daily', 'weekly', 'monthly', 'yearly'];

const DEFAULT_NAME = { lists: 'Eingang', areas: 'Allgemein', categories: 'Allgemein' };
const REF_FIELD = { lists: 'list_id', areas: 'area_id', categories: 'category_id' };

function metaTable(name) {
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${name}_owner ON ${name}(owner)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_${name}_default ON ${name}(owner) WHERE is_default = 1`
  ];
}

const SCHEMA = [
  ...metaTable('lists'),
  ...metaTable('areas'),
  ...metaTable('categories'),
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    parent_id TEXT,
    list_id TEXT,
    area_id TEXT,
    category_id TEXT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    urgency INTEGER NOT NULL DEFAULT 1 CHECK (urgency BETWEEN 1 AND 3),
    importance INTEGER NOT NULL DEFAULT 1 CHECK (importance BETWEEN 1 AND 3),
    rated INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    due_time TEXT,
    recurrence TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, done)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscriptions(owner)`,
  `CREATE TABLE IF NOT EXISTS settings (
    owner TEXT PRIMARY KEY,
    tz TEXT NOT NULL DEFAULT 'Europe/Berlin',
    morning_enabled INTEGER NOT NULL DEFAULT 1,
    morning_time TEXT NOT NULL DEFAULT '07:30',
    last_morning_date TEXT,
    updated_at TEXT
  )`
];

// Spalten, die nach Phase 1 dazugekommen sind (bestehende Tabellen werden ergänzt)
const TASK_MIGRATIONS = {
  remind_offset: 'ALTER TABLE tasks ADD COLUMN remind_offset INTEGER',
  remind_at: 'ALTER TABLE tasks ADD COLUMN remind_at TEXT',
  reminded: 'ALTER TABLE tasks ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0'
};
const POST_MIGRATION = [
  `CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(reminded, remind_at)`
];

let schemaReady = false;
let certCache = null;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

const nowIso = () => new Date().toISOString();

export async function onRequest(context) {
  const { request, env, params } = context;
  try {
    if (!env.DB) throw new HttpError(503, 'D1-Binding "DB" fehlt in den Pages-Einstellungen.');
    const owner = await authenticate(request, env);
    await ensureSchema(env.DB);

    const parts = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
    const [resource, id, extra] = parts;
    const method = request.method;

    if (resource === 'bootstrap' && method === 'GET' && !id) {
      return json(await bootstrap(env.DB, owner));
    }
    if (resource === 'settings' && !id) {
      if (method === 'GET') return json(await getSettings(env.DB, owner));
      if (method === 'PUT') return json(await putSettings(env.DB, owner, await readBody(request)));
      throw new HttpError(405, 'Methode nicht erlaubt.');
    }
    if (resource === 'push' && id && extra === undefined) {
      return json(await pushRoute(env, owner, id, method, request));
    }
    if (!FIELDS[resource] || extra !== undefined) throw new HttpError(404, 'Unbekannte Route.');

    if (method === 'POST' && !id) return json(await createRow(env.DB, owner, resource, await readBody(request)), 201);
    if (method === 'PATCH' && id) return json(await updateRow(env.DB, owner, resource, id, await readBody(request)));
    if (method === 'DELETE' && id) return json(await deleteRow(env.DB, owner, resource, id));
    throw new HttpError(405, 'Methode nicht erlaubt.');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return json({ error: status === 500 ? 'Interner Serverfehler.' : err.message }, status);
  }
}

/* ---------- Authentifizierung über Cloudflare Access (JWT prüfen) ---------- */

async function authenticate(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) throw new HttpError(503, 'ACCESS_TEAM_DOMAIN und ACCESS_AUD sind nicht konfiguriert.');

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Nicht angemeldet.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Ungültiges Token.');

  let header, payload;
  try {
    header = JSON.parse(b64urlText(parts[0]));
    payload = JSON.parse(b64urlText(parts[1]));
  } catch (e) {
    throw new HttpError(401, 'Ungültiges Token.');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Ungültiges Token.');

  const key = await getKey(team, header.kid);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!valid) throw new HttpError(401, 'Ungültige Signatur.');

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new HttpError(401, 'Sitzung abgelaufen.');
  if (payload.nbf && payload.nbf > now + 60) throw new HttpError(401, 'Token noch nicht gültig.');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new HttpError(403, 'Token gehört nicht zu dieser App.');
  if (payload.iss !== 'https://' + team) throw new HttpError(403, 'Falscher Aussteller.');

  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new HttpError(403, 'Keine E-Mail im Token.');
  const allowed = String(env.ALLOWED_EMAILS || '').split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) throw new HttpError(403, 'Kein Zugriff für diese E-Mail.');
  return email;
}

async function getKey(team, kid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stale = !certCache || certCache.team !== team || Date.now() - certCache.at > 3600e3;
    if (stale || attempt === 1) {
      const res = await fetch('https://' + team + '/cdn-cgi/access/certs');
      if (!res.ok) throw new HttpError(503, 'Access-Zertifikate nicht abrufbar.');
      const body = await res.json();
      certCache = { team, at: Date.now(), keys: body.keys || [], imported: {} };
    }
    const jwk = certCache.keys.find(k => k.kid === kid);
    if (jwk) {
      if (!certCache.imported[kid]) {
        certCache.imported[kid] = await crypto.subtle.importKey(
          'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
        );
      }
      return certCache.imported[kid];
    }
  }
  throw new HttpError(401, 'Unbekannter Signaturschlüssel.');
}

function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlText = s => new TextDecoder().decode(b64urlBytes(s));

/* ---------- Datenbank ---------- */

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(sql => db.prepare(sql)));
  const { results } = await db.prepare('PRAGMA table_info(tasks)').all();
  const have = new Set(results.map(c => c.name));
  for (const [col, sql] of Object.entries(TASK_MIGRATIONS)) {
    if (have.has(col)) continue;
    try { await db.prepare(sql).run(); } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e; // parallele Migration
    }
  }
  await db.batch(POST_MIGRATION.map(sql => db.prepare(sql)));
  schemaReady = true;
}

/* ---------- Einstellungen ---------- */

const SETTINGS_DEFAULT = { tz: 'Europe/Berlin', morning_enabled: 1, morning_time: '07:30' };

async function getSettings(db, owner) {
  const row = await db.prepare('SELECT tz, morning_enabled, morning_time FROM settings WHERE owner = ?').bind(owner).first();
  return { ...SETTINGS_DEFAULT, ...(row || {}) };
}

async function putSettings(db, owner, body) {
  const cur = await getSettings(db, owner);
  if ('tz' in body) {
    const tz = String(body.tz || '').slice(0, 64);
    try { new Intl.DateTimeFormat('de-DE', { timeZone: tz }); cur.tz = tz; }
    catch (e) { throw new HttpError(400, 'Unbekannte Zeitzone.'); }
  }
  if ('morning_enabled' in body) cur.morning_enabled = body.morning_enabled ? 1 : 0;
  if ('morning_time' in body) {
    const t = String(body.morning_time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, 'Uhrzeit muss HH:MM sein.');
    cur.morning_time = t;
  }
  await db.prepare(`INSERT INTO settings (owner, tz, morning_enabled, morning_time, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner) DO UPDATE SET tz = excluded.tz, morning_enabled = excluded.morning_enabled,
    morning_time = excluded.morning_time, updated_at = excluded.updated_at`)
    .bind(owner, cur.tz, cur.morning_enabled, cur.morning_time, nowIso()).run();
  return cur;
}

/* ---------- Push ---------- */

function vapidFromEnv(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) throw new HttpError(503, 'Push ist noch nicht eingerichtet (VAPID-Schlüssel fehlen).');
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_JWK, subject: env.VAPID_SUBJECT || 'mailto:todoapp@example.com' };
}

async function pushRoute(env, owner, action, method, request) {
  const db = env.DB;
  if (action === 'key' && method === 'GET') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner = ?').bind(owner).first();
    return { publicKey: env.VAPID_PUBLIC_KEY || null, devices: n ? n.n : 0 };
  }
  if (method !== 'POST') throw new HttpError(405, 'Methode nicht erlaubt.');

  if (action === 'subscribe') {
    const b = await readBody(request);
    const endpoint = String(b.endpoint || '');
    const keys = b.keys || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) throw new HttpError(400, 'Ungültiger Endpoint.');
    if (!keys.p256dh || !keys.auth) throw new HttpError(400, 'Schlüssel fehlen.');
    const ua = String(request.headers.get('User-Agent') || '').slice(0, 300);
    await db.prepare(`INSERT INTO push_subscriptions (id, owner, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
      .bind(crypto.randomUUID(), owner, endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100), ua, nowIso()).run();
    // Einstellungszeile anlegen, damit die Morgen-Übersicht greift
    await db.prepare('INSERT OR IGNORE INTO settings (owner, updated_at) VALUES (?, ?)').bind(owner, nowIso()).run();
    return { ok: true };
  }
  if (action === 'unsubscribe') {
    const b = await readBody(request);
    await db.prepare('DELETE FROM push_subscriptions WHERE owner = ? AND endpoint = ?').bind(owner, String(b.endpoint || '')).run();
    return { ok: true };
  }
  if (action === 'test') {
    const sent = await pushToOwner(db, owner, {
      title: 'ToDoApp', body: 'Testbenachrichtigung – Push funktioniert. ✓', tag: 'test', url: '/'
    }, vapidFromEnv(env));
    if (!sent) throw new HttpError(502, 'Kein Gerät hat die Nachricht angenommen.');
    return { ok: true, sent };
  }
  throw new HttpError(404, 'Unbekannte Route.');
}

async function defaultId(db, owner, table) {
  const row = await db.prepare(`SELECT id FROM ${table} WHERE owner = ? AND is_default = 1`).bind(owner).first();
  return row ? row.id : null;
}

async function bootstrap(db, owner) {
  const ts = nowIso();
  await db.batch(Object.keys(DEFAULT_NAME).map(t =>
    db.prepare(`INSERT OR IGNORE INTO ${t} (id, owner, name, sort, is_default, created_at) VALUES (?, ?, ?, 0, 1, ?)`)
      .bind(crypto.randomUUID(), owner, DEFAULT_NAME[t], ts)
  ));
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
  const order = 'ORDER BY is_default DESC, name COLLATE NOCASE';
  const [lists, areas, categories, tasks] = await db.batch([
    db.prepare(`SELECT * FROM lists WHERE owner = ? ${order}`).bind(owner),
    db.prepare(`SELECT * FROM areas WHERE owner = ? ${order}`).bind(owner),
    db.prepare(`SELECT * FROM categories WHERE owner = ? ${order}`).bind(owner),
    // Erledigte Aufgaben nur der letzten 90 Tage laden (Unteraufgaben immer)
    db.prepare(`SELECT * FROM tasks WHERE owner = ? AND (done = 0 OR done_at >= ? OR parent_id IS NOT NULL)`).bind(owner, cutoff)
  ]);
  const strip = rows => rows.results.map(r => { const c = { ...r }; delete c.owner; return c; });
  return {
    user: owner, lists: strip(lists), areas: strip(areas), categories: strip(categories), tasks: strip(tasks),
    settings: await getSettings(db, owner)
  };
}

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'JSON erwartet.');
  let body;
  try { body = await request.json(); } catch (e) { throw new HttpError(400, 'Ungültiges JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Objekt erwartet.');
  return body;
}

function clean(resource, body) {
  const out = {};
  for (const f of FIELDS[resource]) {
    if (!(f in body)) continue;
    let v = body[f];
    switch (f) {
      case 'name':
      case 'title':
        v = String(v == null ? '' : v).trim().slice(0, 500);
        if (!v) throw new HttpError(400, 'Titel bzw. Name darf nicht leer sein.');
        break;
      case 'notes':
        v = String(v == null ? '' : v).slice(0, 20000);
        break;
      case 'color':
        v = v ? String(v).slice(0, 200) : null;
        break;
      case 'recurrence':
        v = v ? validRecurrence(v) : null;
        break;
      case 'remind_offset':
        if (v === null || v === undefined || v === '') { v = null; break; }
        v = parseInt(v, 10);
        if (!(v >= 0 && v <= 10080)) throw new HttpError(400, 'Erinnerungsvorlauf ungültig.');
        break;
      case 'remind_at':
        v = v ? String(v) : null;
        if (v && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(v) || isNaN(Date.parse(v)))) {
          throw new HttpError(400, 'Erinnerungszeit ungültig.');
        }
        if (v) v = new Date(v).toISOString();
        break;
      case 'urgency':
      case 'importance':
        v = Math.min(3, Math.max(1, parseInt(v, 10) || 1));
        break;
      case 'rated':
      case 'done':
        v = v ? 1 : 0;
        break;
      case 'sort':
        v = Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0;
        break;
      case 'due_date':
        v = v ? String(v) : null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Datum muss JJJJ-MM-TT sein.');
        break;
      case 'due_time':
        v = v ? String(v).slice(0, 5) : null;
        if (v && !/^\d{2}:\d{2}$/.test(v)) throw new HttpError(400, 'Uhrzeit muss HH:MM sein.');
        break;
      default: // parent_id, list_id, area_id, category_id
        v = v ? String(v).slice(0, 64) : null;
    }
    out[f] = v;
  }
  return out;
}

/** Wiederholung als JSON: { freq, interval, byweekday?: [0..6], until?: 'JJJJ-MM-TT' } */
function validRecurrence(v) {
  let r;
  try { r = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { throw new HttpError(400, 'Wiederholung ungültig.'); }
  if (!r || !RECUR_FREQ.includes(r.freq)) throw new HttpError(400, 'Wiederholung ungültig.');
  const out = { freq: r.freq, interval: Math.min(999, Math.max(1, parseInt(r.interval, 10) || 1)) };
  if (r.freq === 'weekly' && Array.isArray(r.byweekday) && r.byweekday.length) {
    out.byweekday = [...new Set(r.byweekday.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6))].sort();
  }
  if ((r.freq === 'monthly' || r.freq === 'yearly') && r.dom) {
    out.dom = Math.min(31, Math.max(1, parseInt(r.dom, 10) || 1));
  }
  if (r.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.until))) throw new HttpError(400, 'Enddatum ungültig.');
    out.until = String(r.until);
  }
  return JSON.stringify(out);
}

/** Verweise auf Liste/Bereich/Kategorie prüfen; Unbekanntes fällt auf "Allgemein"/"Eingang" zurück. */
async function fixRefs(db, owner, data, taskId) {
  for (const table of Object.keys(REF_FIELD)) {
    const f = REF_FIELD[table];
    if (!(f in data)) continue;
    const ok = data[f]
      ? await db.prepare(`SELECT id FROM ${table} WHERE id = ? AND owner = ?`).bind(data[f], owner).first()
      : null;
    if (!ok) data[f] = await defaultId(db, owner, table);
  }
  if (data.parent_id) {
    if (data.parent_id === taskId) throw new HttpError(400, 'Aufgabe kann nicht ihre eigene Unteraufgabe sein.');
    const parent = await db.prepare('SELECT id FROM tasks WHERE id = ? AND owner = ? AND parent_id IS NULL')
      .bind(data.parent_id, owner).first();
    if (!parent) throw new HttpError(400, 'Übergeordnete Aufgabe nicht gefunden.');
  }
}

async function getRow(db, owner, resource, id) {
  const row = await db.prepare(`SELECT * FROM ${resource} WHERE id = ? AND owner = ?`).bind(id, owner).first();
  if (row) delete row.owner;
  return row;
}

async function createRow(db, owner, resource, body) {
  const data = clean(resource, body);
  const id = body.id ? String(body.id).slice(0, 64) : crypto.randomUUID();
  const ts = nowIso();

  if (resource === 'tasks') {
    if (!data.title) throw new HttpError(400, 'Titel fehlt.');
    for (const f of Object.values(REF_FIELD)) if (!(f in data)) data[f] = null;
    await fixRefs(db, owner, data, id);
    data.updated_at = ts;
    if (data.done) data.done_at = ts;
    data.reminded = 0;
  } else if (!data.name) {
    throw new HttpError(400, 'Name fehlt.');
  }

  const row = { ...data, id, owner, created_at: ts };
  const cols = Object.keys(row);
  try {
    await db.prepare(`INSERT INTO ${resource} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map(c => row[c])).run();
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test(String(e && e.message))) throw new HttpError(409, 'ID existiert bereits.');
    throw e;
  }
  return getRow(db, owner, resource, id);
}

async function updateRow(db, owner, resource, id, body) {
  const data = clean(resource, body);
  if (!Object.keys(data).length) throw new HttpError(400, 'Keine gültigen Felder.');
  if (resource === 'tasks') {
    await fixRefs(db, owner, data, id);
    const ts = nowIso();
    data.updated_at = ts;
    if ('done' in data) data.done_at = data.done ? ts : null;
    if ('remind_at' in data) data.reminded = 0; // neue Zeit -> erneut erinnern
  }
  const cols = Object.keys(data);
  const res = await db.prepare(`UPDATE ${resource} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ? AND owner = ?`)
    .bind(...cols.map(c => data[c]), id, owner).run();
  if (!res.meta || !res.meta.changes) throw new HttpError(404, 'Nicht gefunden.');
  return getRow(db, owner, resource, id);
}

async function deleteRow(db, owner, resource, id) {
  if (resource === 'tasks') {
    await db.prepare('DELETE FROM tasks WHERE owner = ? AND (id = ? OR parent_id = ?)').bind(owner, id, id).run();
    return { ok: true };
  }
  const row = await db.prepare(`SELECT is_default FROM ${resource} WHERE id = ? AND owner = ?`).bind(id, owner).first();
  if (!row) throw new HttpError(404, 'Nicht gefunden.');
  if (row.is_default) throw new HttpError(400, 'Der Standardeintrag kann nicht gelöscht werden.');
  const def = await defaultId(db, owner, resource);
  const f = REF_FIELD[resource];
  await db.batch([
    db.prepare(`UPDATE tasks SET ${f} = ?, updated_at = ? WHERE owner = ? AND ${f} = ?`).bind(def, nowIso(), owner, id),
    db.prepare(`DELETE FROM ${resource} WHERE id = ? AND owner = ?`).bind(id, owner)
  ]);
  return { ok: true, moved_to: def };
}
