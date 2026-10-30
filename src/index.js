import qrcode from "qrcode-generator";
import { hmac, signValue, verifyValue } from "./crypto.js";
import { CHUNK_BYTES, CODE_TTL_MS, DOWNLOAD_TOKEN_TTL_MS, JOIN_COOKIE_TTL_MS } from "./limits.js";

export { Room, CodeSlot } from "./room.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;
const COOKIE_NAME = "room";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function errorResponse(error) {
  const match = /^(\d{3})\|(.*)$/s.exec(error.message ?? "");
  if (match) return json({ error: match[2] }, Number(match[1]));
  console.error(error);
  return json({ error: "Erreur du serveur. Réessaie." }, 500);
}

function networkKey(ip) {
  if (!ip.includes(":")) return ip;
  // IPv6 devices on one network share the /64 prefix but rotate the rest.
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = ip.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...zeros, ...right]
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
}

// The IP only ever exists here, inside an HMAC. It is never stored.
async function networkRoomId(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
  return (await hmac(env.ROOM_SECRET, `network:${networkKey(ip)}`)).slice(0, 32);
}

function readCookie(request) {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

async function callerRoom(request, env) {
  const joined = await verifyValue(env.ROOM_SECRET, "join", readCookie(request));
  const roomId = joined ?? (await networkRoomId(request, env));
  return { roomId, joined: Boolean(joined), room: env.ROOMS.get(env.ROOMS.idFromName(roomId)) };
}

// Room access follows the IP, so a page on another site opened from this network
// could otherwise read and write through the visitor's browser.
function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

function needsJsonGuard(request) {
  return !["GET", "HEAD"].includes(request.method) && request.headers.get("X-Requested-With") !== "copy-and-paste";
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
    throw new Error("415|Format de requête invalide.");
  }
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > 512 * 1024) throw new Error("413|Requête trop volumineuse.");
  try {
    return await request.json();
  } catch {
    throw new Error("400|Format de requête invalide.");
  }
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function serveFile(request, env, url, roomId, room, itemId) {
  const info = await room.fileInfo(itemId);
  if (info.locked) {
    const allowed = await verifyValue(env.ROOM_SECRET, `file:${roomId}`, url.searchParams.get("t"));
    if (allowed !== itemId) throw new Error("403|PIN requis pour ce contenu.");
  }

  const object = await env.FILES.get(info.key, { range: request.headers });
  if (!object) throw new Error("404|Contenu introuvable ou expiré.");

  const inline = url.searchParams.get("inline") === "1";
  const headers = new Headers({
    "Content-Type": info.mime,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", info.name),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });

  if (request.headers.has("Range") && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

async function handleApi(request, env, url) {
  if (!env.ROOM_SECRET) {
    console.error("ROOM_SECRET is not set");
    return json({ error: "Service mal configuré." }, 500);
  }
  if (!sameOrigin(request, url)) return json({ error: "Origine refusée." }, 403);
  if (needsJsonGuard(request)) return json({ error: "Requête refusée." }, 403);

  const path = url.pathname.slice("/api/".length).split("/");
  const method = request.method;
  const route = `${method} ${path[0]}`;

  if (route === "GET ws") {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "WebSocket attendu." }, 426);
    const { room } = await callerRoom(request, env);
    return room.fetch(request);
  }

  if (route === "GET qr") {
    const code = url.searchParams.get("code") ?? "";
    if (!CODE_PATTERN.test(code)) return json({ error: "Code invalide." }, 400);
    const qr = qrcode(0, "M");
    qr.addData(`${url.origin}/#c=${code}`);
    qr.make();
    return new Response(qr.createSvgTag({ cellSize: 6, margin: 12, scalable: true }), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
    });
  }

  if (route === "POST join") {
    const networkRoom = env.ROOMS.get(env.ROOMS.idFromName(await networkRoomId(request, env)));
    if (!(await networkRoom.joinAllowed())) return json({ error: "Trop d'essais. Réessaie dans une heure." }, 429);
    const { code } = await readJson(request);
    const normalized = String(code ?? "").trim().toUpperCase();
    const roomId = CODE_PATTERN.test(normalized)
      ? await env.CODES.get(env.CODES.idFromName(normalized)).read()
      : null;
    if (!roomId) {
      await networkRoom.recordJoinFailure();
      return json({ error: "Code inconnu ou expiré." }, 404);
    }
    const cookie = await signValue(env.ROOM_SECRET, "join", roomId, Date.now() + JOIN_COOKIE_TTL_MS);
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${JOIN_COOKIE_TTL_MS / 1000}`,
    });
  }

  if (route === "POST leave") {
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0` });
  }

  const { roomId, joined, room } = await callerRoom(request, env);

  if (route === "GET room") return json({ joined, items: await room.list() });

  if (route === "POST code") {
    const expiresAt = Date.now() + CODE_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      if (await env.CODES.get(env.CODES.idFromName(code)).claim(roomId, expiresAt)) {
        return json({ code, expiresAt });
      }
    }
    return json({ error: "Réessaie dans un instant." }, 503);
  }

  if (route === "POST text") {
    const { text, pin } = await readJson(request);
    return json(await room.addText(text, pin), 201);
  }

  if (path[0] === "uploads") {
    const id = path[1];
    if (method === "POST" && path.length === 1) {
      const { name, size, mime, pin } = await readJson(request);
      return json(await room.beginUpload(roomId, { name, size, mime, pin }), 201);
    }
    if (method === "PUT" && path.length === 3) {
      const partNumber = Number(path[2]);
      const target = await room.partTarget(id, partNumber);
      const declared = Number(request.headers.get("Content-Length") ?? -1);
      if (declared !== target.expected || declared > CHUNK_BYTES) return json({ error: "Taille de morceau invalide." }, 400);
      const body = await request.arrayBuffer();
      if (body.byteLength !== target.expected) return json({ error: "Taille de morceau invalide." }, 400);
      const part = await env.FILES.resumeMultipartUpload(target.key, target.uploadId).uploadPart(partNumber, body);
      await room.recordPart(id, partNumber, part.etag);
      return json({ ok: true });
    }
    if (method === "POST" && path[2] === "complete") return json(await room.completeUpload(id));
  }

  if (path[0] === "items" && path[1]) {
    const id = path[1];
    if (method === "DELETE" && path.length === 2) return json(await room.deleteItem(id));
    if (method === "POST" && path[2] === "unlock") {
      const { pin } = await readJson(request);
      const item = await room.unlock(id, pin);
      if (item.kind !== "file") return json(item);
      const token = await signValue(env.ROOM_SECRET, `file:${roomId}`, id, Date.now() + DOWNLOAD_TOKEN_TTL_MS);
      return json({ ...item, token });
    }
    if (method === "GET" && path[2] === "file") return serveFile(request, env, url, roomId, room, id);
  }

  return json({ error: "Introuvable." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
