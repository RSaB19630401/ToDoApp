/**
 * ToDoApp – Erinnerungs-Worker (Cloudflare Worker mit Cron "*/5 * * * *")
 * Schickt alle 5 Minuten fällige Erinnerungen und einmal täglich die Morgen-Übersicht.
 *
 * Bindings / Variablen:
 *   DB                 D1-Datenbank todoapp-db (dieselbe wie die App)
 *   VAPID_PUBLIC_KEY   öffentlicher VAPID-Schlüssel
 *   VAPID_PRIVATE_JWK  privater VAPID-Schlüssel (Secret)
 *   VAPID_SUBJECT      mailto:-Adresse
 *
 * Wird per Cloudflare-API deployt (Module: reminder-worker/worker.js + lib/webpush.js).
 */
import { pushToOwner } from '../lib/webpush.js';

const LEVEL = { 1: 'niedrig', 2: 'mittel', 3: 'hoch' };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, new Date(event.scheduledTime || Date.now())));
  },
  async fetch() {
    return new Response('ToDoApp Reminder Worker läuft.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};

export async function run(env, now) {
  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_JWK, subject: env.VAPID_SUBJECT || 'mailto:todoapp@example.com' };
  if (!vapid.publicKey || !vapid.privateJwk) { console.log('VAPID-Schlüssel fehlen'); return; }
  try { await reminders(env.DB, vapid, now); } catch (e) { console.log('Erinnerungen:', String(e)); }
  try { await morning(env.DB, vapid, now); } catch (e) { console.log('Morgen-Übersicht:', String(e)); }
}

/* ---------- Einzelne Erinnerungen ---------- */

async function reminders(db, vapid, now) {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - 6 * 3600e3).toISOString();
  const { results } = await db.prepare(
    `SELECT id, owner, title, due_date, due_time, remind_at, remind_offset, urgency, importance FROM tasks
     WHERE reminded = 0 AND done = 0 AND remind_at IS NOT NULL AND remind_at <= ?
     ORDER BY remind_at LIMIT 100`
  ).bind(nowIso).all();

  for (const t of results) {
    // Zuerst markieren, damit nichts doppelt verschickt wird, falls der Lauf abbricht
    await db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').bind(t.id).run();
    if (t.remind_at < staleIso) continue; // älter als 6 Std. (z. B. Ausfall) -> nicht mehr nachschicken
    let body = 'Fällig ' + (t.remind_offset ? offsetText(t.remind_offset) : 'jetzt') + (t.due_time ? ' (' + t.due_time + ' Uhr)' : '');
    if (t.urgency === 3 || t.importance === 3) body += ' · D ' + LEVEL[t.urgency] + ' / W ' + LEVEL[t.importance];
    await pushToOwner(db, t.owner, { title: t.title, body, tag: 'task-' + t.id, url: '/?task=' + encodeURIComponent(t.id) }, vapid);
  }
}

function offsetText(min) {
  if (min >= 1440 && min % 1440 === 0) return min === 1440 ? 'morgen' : 'in ' + (min / 1440) + ' Tagen';
  if (min >= 60 && min % 60 === 0) return 'in ' + (min / 60) + ' Std.';
  return 'in ' + min + ' Min.';
}

/* ---------- Morgen-Übersicht ---------- */

function localParts(now, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}

async function morning(db, vapid, now) {
  const { results } = await db.prepare(
    `SELECT s.owner, s.tz, s.morning_time, s.last_morning_date FROM settings s
     WHERE s.morning_enabled = 1 AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.owner = s.owner)`
  ).all();

  for (const s of results) {
    let local;
    try { local = localParts(now, s.tz || 'Europe/Berlin'); } catch (e) { local = localParts(now, 'Europe/Berlin'); }
    const [h, m] = String(s.morning_time || '07:30').split(':').map(Number);
    const target = h * 60 + m;
    // Fenster von 60 Min., damit ein verpasster Cron-Lauf nachgeholt wird, aber nicht abends
    if (local.minutes < target || local.minutes > target + 60 || s.last_morning_date === local.date) continue;

    await db.prepare('UPDATE settings SET last_morning_date = ? WHERE owner = ?').bind(local.date, s.owner).run();

    const { results: open } = await db.prepare(
      `SELECT title, due_date, due_time, urgency, importance FROM tasks
       WHERE owner = ? AND done = 0 AND parent_id IS NULL`
    ).bind(s.owner).all();

    const today = open.filter(t => t.due_date === local.date);
    const overdue = open.filter(t => t.due_date && t.due_date < local.date);
    const top = open.filter(t => t.urgency + t.importance >= 5 || (t.due_date && t.due_date <= local.date))
      .sort((a, b) => (b.urgency + b.importance) - (a.urgency + a.importance) || String(a.due_time || '99').localeCompare(String(b.due_time || '99')))
      .slice(0, 3);

    if (!today.length && !overdue.length && !top.length) continue; // nichts zu melden -> keine Nachricht

    const parts = [];
    parts.push(today.length + ' heute fällig');
    if (overdue.length) parts.push(overdue.length + ' überfällig');
    let body = parts.join(', ') + '.';
    if (top.length) body += '\nZuerst: ' + top.map(t => t.title + (t.due_time && t.due_date === local.date ? ' (' + t.due_time + ')' : '')).join(' · ');

    await pushToOwner(db, s.owner, { title: 'Guten Morgen – dein Tag', body, tag: 'morning', url: '/?view=today' }, vapid, { ttl: 4 * 3600 });
  }
}
