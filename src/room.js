import { DurableObject } from "cloudflare:workers";
import { hmac, randomToken, safeEqual } from "./crypto.js";
import {
  ALLOWED_MIME,
  CHUNK_BYTES,
  JOIN_WINDOW_MS,
  MAX_FILE_BYTES,
  MAX_JOIN_FAILURES,
  MAX_PIN_TRIES,
  MAX_ROOM_BYTES,
  MAX_ROOM_ITEMS,
  MAX_TEXT_CHARS,
  TTL_MS,
} from "./limits.js";

// RPC only carries the message of a thrown error, so the status travels inside it.
function fail(status, message) {
  throw new Error(`${status}|${message}`);
}

function cleanFileName(name) {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned || "fichier";
}

function checkPin(pin) {
  if (pin === undefined || pin === null || pin === "") return null;
  if (!/^\d{4,8}$/.test(String(pin))) fail(400, "Le PIN doit contenir 4 à 8 chiffres.");
  return String(pin);
}

// One room per network or per joined code. Every read and write on an item goes
// through this object, so an id from another room simply does not exist here.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT,
        name TEXT,
        mime TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        r2_key TEXT,
        upload_id TEXT,
        parts TEXT,
        pin_salt TEXT,
        pin_hash TEXT,
        pin_tries INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_failures (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage() {}
  webSocketClose(ws, code) {
    try {
      ws.close(code === 1006 || code === 1005 ? 1000 : code);
    } catch {}
  }

  notify() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send('{"type":"changed"}');
      } catch {}
    }
  }

  row(id) {
    return this.sql
      .exec("SELECT * FROM items WHERE id = ? AND expires_at > ?", id, Date.now())
      .toArray()[0];
  }

  readyRow(id) {
    const row = this.row(id);
    if (!row || row.status !== "ready") fail(404, "Contenu introuvable ou expiré.");
    return row;
  }

  checkQuota(extraBytes) {
    const { n, total } = this.sql
      .exec(
        "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM items WHERE expires_at > ?",
        Date.now(),
      )
      .one();
    if (n >= MAX_ROOM_ITEMS) fail(429, "Trop de contenus sur ce réseau. Supprimes-en ou attends leur expiration.");
    if (total + extraBytes > MAX_ROOM_BYTES) fail(429, "Espace plein sur ce réseau pour l'instant.");
  }

  async pinFields(pin) {
    if (!pin) return { salt: null, hash: null };
    const salt = randomToken();
    return { salt, hash: await hmac(this.env.ROOM_SECRET, `pin:${salt}:${pin}`) };
  }

  async scheduleAlarm() {
    const next = this.sql.exec("SELECT MIN(expires_at) AS at FROM items").one().at;
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }

  async removeStored(row) {
    if (!row.r2_key) return;
    if (row.status === "pending") {
      await this.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => {});
    } else {
      await this.env.FILES.delete(row.r2_key);
    }
  }

  async alarm() {
    const expired = this.sql.exec("SELECT * FROM items WHERE expires_at <= ?", Date.now()).toArray();
    for (const row of expired) {
      await this.removeStored(row);
      this.sql.exec("DELETE FROM items WHERE id = ?", row.id);
    }
    await this.scheduleAlarm();
    if (expired.length) this.notify();
  }

  list() {
    return this.sql
      .exec(
        "SELECT * FROM items WHERE status = 'ready' AND expires_at > ? ORDER BY created_at DESC",
        Date.now(),
      )
      .toArray()
      .map((row) => {
        const shared = { id: row.id, kind: row.kind, createdAt: row.created_at, expiresAt: row.expires_at };
        if (row.pin_hash) return { ...shared, locked: true };
        return { ...shared, locked: false, text: row.text, name: row.name, mime: row.mime, size: row.size };
      });
  }

  async addText(text, rawPin) {
    const pin = checkPin(rawPin);
    if (typeof text !== "string" || !text.trim()) fail(400, "Le texte est vide.");
    if (text.length > MAX_TEXT_CHARS) fail(413, "Texte trop long (100 000 caractères maximum).");
    this.checkQuota(0);
    const { salt, hash } = await this.pinFields(pin);
    const id = randomToken();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO items (id, kind, status, text, pin_salt, pin_hash, created_at, expires_at)
       VALUES (?, 'text', 'ready', ?, ?, ?, ?, ?)`,
      id, text, salt, hash, now, now + TTL_MS,
    );
    await this.scheduleAlarm();
    this.notify();
    return { id };
  }

  async beginUpload(roomId, { name, size, mime, pin: rawPin }) {
    const pin = checkPin(rawPin);
    if (!ALLOWED_MIME.has(mime)) fail(415, "Seules les images et les vidéos sont acceptées.");
    if (!Number.isSafeInteger(size) || size <= 0) fail(400, "Fichier vide ou taille invalide.");
    if (size > MAX_FILE_BYTES) fail(413, "Fichier trop lourd (200 Mo maximum).");
    this.checkQuota(size);

    const id = randomToken();
    const key = `${roomId}/${id}`;
    const fileName = cleanFileName(name);
    const upload = await this.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
    const { salt, hash } = await this.pinFields(pin);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO items (id, kind, status, name, mime, size, r2_key, upload_id, parts, pin_salt, pin_hash, created_at, expires_at)
       VALUES (?, 'file', 'pending', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      id, fileName, mime, size, key, upload.uploadId, salt, hash, now, now + TTL_MS,
    );
    await this.scheduleAlarm();
    return { id, chunkSize: CHUNK_BYTES };
  }

  // Each part has an exact expected size, so the declared file size cannot be exceeded.
  partTarget(id, partNumber) {
    const row = this.row(id);
    if (!row || row.status !== "pending") fail(404, "Envoi introuvable ou expiré.");
    const total = Math.ceil(row.size / CHUNK_BYTES);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > total) fail(400, "Morceau invalide.");
    const expected = partNumber === total ? row.size - CHUNK_BYTES * (total - 1) : CHUNK_BYTES;
    return { key: row.r2_key, uploadId: row.upload_id, expected };
  }

  recordPart(id, partNumber, etag) {
    const row = this.row(id);
    if (!row || row.status !== "pending") fail(404, "Envoi introuvable ou expiré.");
    const parts = JSON.parse(row.parts).filter((part) => part.partNumber !== partNumber);
    parts.push({ partNumber, etag });
    this.sql.exec("UPDATE items SET parts = ? WHERE id = ?", JSON.stringify(parts), id);
  }

  async completeUpload(id) {
    const row = this.row(id);
    if (!row || row.status !== "pending") fail(404, "Envoi introuvable ou expiré.");
    const parts = JSON.parse(row.parts).sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length !== Math.ceil(row.size / CHUNK_BYTES)) fail(400, "Envoi incomplet.");
    await this.env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).complete(parts);
    this.sql.exec("UPDATE items SET status = 'ready', parts = NULL, upload_id = NULL WHERE id = ?", id);
    this.notify();
    return { id };
  }

  async deleteItem(id) {
    const row = this.row(id);
    if (!row) fail(404, "Contenu introuvable ou expiré.");
    await this.removeStored(row);
    this.sql.exec("DELETE FROM items WHERE id = ?", id);
    this.notify();
    return { ok: true };
  }

  // Too many wrong PINs destroy the item, which caps guessing on a 4 digit PIN.
  async unlock(id, rawPin) {
    const row = this.readyRow(id);
    if (!row.pin_hash) fail(400, "Ce contenu n'a pas de PIN.");
    const pin = checkPin(rawPin);
    const attempt = pin ? await hmac(this.env.ROOM_SECRET, `pin:${row.pin_salt}:${pin}`) : "";
    if (!safeEqual(attempt, row.pin_hash)) {
      const tries = row.pin_tries + 1;
      if (tries >= MAX_PIN_TRIES) {
        await this.deleteItem(id);
        fail(403, "Trop d'erreurs : le contenu a été supprimé.");
      }
      this.sql.exec("UPDATE items SET pin_tries = ? WHERE id = ?", tries, id);
      fail(403, `PIN incorrect. Il reste ${MAX_PIN_TRIES - tries} essai(s).`);
    }
    return { kind: row.kind, text: row.text, name: row.name, mime: row.mime, size: row.size };
  }

  fileInfo(id) {
    const row = this.readyRow(id);
    if (row.kind !== "file") fail(404, "Contenu introuvable ou expiré.");
    return { key: row.r2_key, name: row.name, mime: row.mime, size: row.size, locked: Boolean(row.pin_hash) };
  }

  joinAllowed() {
    const row = this.sql.exec("SELECT * FROM join_failures").toArray()[0];
    return !row || Date.now() - row.window_start > JOIN_WINDOW_MS || row.count < MAX_JOIN_FAILURES;
  }

  recordJoinFailure() {
    const now = Date.now();
    const row = this.sql.exec("SELECT * FROM join_failures").toArray()[0];
    const fresh = !row || now - row.window_start > JOIN_WINDOW_MS;
    this.sql.exec(
      "INSERT OR REPLACE INTO join_failures (id, count, window_start) VALUES (1, ?, ?)",
      fresh ? 1 : row.count + 1,
      fresh ? now : row.window_start,
    );
  }
}

export class CodeSlot extends DurableObject {
  async claim(roomId, expiresAt) {
    const current = await this.ctx.storage.get("slot");
    if (current && current.expiresAt > Date.now()) return false;
    await this.ctx.storage.put("slot", { roomId, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  async read() {
    const slot = await this.ctx.storage.get("slot");
    return slot && slot.expiresAt > Date.now() ? slot.roomId : null;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
