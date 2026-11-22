/**
 * Web Push ohne Abhängigkeiten (nur WebCrypto) – für Pages Functions und Workers.
 *  - Verschlüsselung nach RFC 8291 (Content-Encoding: aes128gcm, RFC 8188)
 *  - VAPID-Authentifizierung nach RFC 8292 (ES256)
 *
 * Erwartet:
 *   vapid = { publicKey: '<base64url, 65 Byte unkomprimiert>', privateJwk: '<JWK als JSON-String>', subject: 'mailto:…' }
 *   sub   = { endpoint, p256dh, auth }   (wie aus PushSubscription.toJSON())
 */

const enc = new TextEncoder();

export function b64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

/**
 * Verschlüsselt eine Nachricht für eine Push-Subscription (eine Record, aes128gcm).
 * `testKeys` ({ asPrivateJwk, asPublic, salt }) nur für Tests mit festen Werten.
 */
export async function encryptPayload(plaintext, p256dh, authSecret, testKeys) {
  const uaPublic = typeof p256dh === 'string' ? b64uToBytes(p256dh) : p256dh;
  const auth = typeof authSecret === 'string' ? b64uToBytes(authSecret) : authSecret;
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;

  let asPrivate, asPublic, salt;
  if (testKeys) {
    asPrivate = await crypto.subtle.importKey('jwk', testKeys.asPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublic = testKeys.asPublic;
    salt = testKeys.salt;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(data, new Uint8Array([2])); // 0x02 = letzter Record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

const vapidKeyCache = new Map();

export async function vapidHeader(endpoint, vapid, nowSec) {
  const aud = new URL(endpoint).origin;
  let key = vapidKeyCache.get(vapid.privateJwk);
  if (!key) {
    const jwk = typeof vapid.privateJwk === 'string' ? JSON.parse(vapid.privateJwk) : vapid.privateJwk;
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    vapidKeyCache.set(vapid.privateJwk, key);
  }
  const now = nowSec || Math.floor(Date.now() / 1000);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: vapid.subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + bytesToB64u(sig) + ', k=' + vapid.publicKey;
}

/**
 * Sendet eine Push-Nachricht. Rückgabe: { ok, status, gone }
 * gone = true heißt: Subscription existiert nicht mehr (404/410) und sollte gelöscht werden.
 */
export async function sendPush(sub, message, vapid, options = {}) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl || 6 * 3600),
      Urgency: options.urgency || 'high',
      ...(options.topic ? { Topic: options.topic } : {})
    },
    body
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** Schickt an alle Geräte eines Nutzers und entfernt abgelaufene Abos. Gibt Anzahl erfolgreicher Zustellungen zurück. */
export async function pushToOwner(db, owner, message, vapid, options) {
  const { results } = await db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner = ?').bind(owner).all();
  let sent = 0;
  for (const sub of results) {
    try {
      const r = await sendPush(sub, message, vapid, options);
      if (r.ok) sent++;
      else if (r.gone) await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
      else console.log('Push fehlgeschlagen', r.status, sub.endpoint.slice(0, 60));
    } catch (e) {
      console.log('Push-Fehler', String(e));
    }
  }
  return sent;
}
