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
 * Routen:
 *   GET    /api/bootstrap
 *   POST   /api/{tasks|lists|areas|categories}
 *   PATCH  /api/{tasks|lists|areas|categories}/{id}
 *   DELETE /api/{tasks|lists|areas|categories}/{id}
 */

const FIELDS = {
  lists: ['name', 'color', 'sort'],
  areas: ['name', 'color', 'sort'],
  categories: ['name', 'color', 'sort'],
  tasks: ['parent_id', 'list_id', 'area_id', 'category_id', 'title', 'notes',
    'urgency', 'importance', 'rated', 'due_date', 'due_time', 'recurrence', 'done', 'sort']
};

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
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`
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
  schemaReady = true;
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
  return { user: owner, lists: strip(lists), areas: strip(areas), categories: strip(categories), tasks: strip(tasks) };
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
      case 'recurrence':
        v = v ? String(v).slice(0, 200) : null;
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
