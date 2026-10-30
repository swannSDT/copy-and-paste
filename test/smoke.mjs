// Runs against a local server started with `npm run dev`.
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:8787";
const GUARD = { "X-Requested-With": "copy-and-paste" };
const jsonHeaders = { ...GUARD, "Content-Type": "application/json" };

async function call(path, { method = "GET", body, headers = jsonHeaders } = {}) {
  const response = await fetch(`${BASE}/api/${path}`, {
    method,
    headers,
    body: body === undefined || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const isJson = response.headers.get("content-type")?.includes("json");
  return { status: response.status, data: isJson ? await response.json() : null, response };
}

async function postFile(size, mime = "image/png", pin) {
  const { status, data } = await call("uploads", { method: "POST", body: { name: "t.png", size, mime, pin } });
  assert.equal(status, 201);
  const parts = Math.ceil(size / data.chunkSize);
  for (let n = 1; n <= parts; n++) {
    const length = n === parts ? size - data.chunkSize * (parts - 1) : data.chunkSize;
    const put = await call(`uploads/${data.id}/${n}`, {
      method: "PUT",
      body: new Uint8Array(length).fill(n),
      headers: { ...GUARD, "Content-Type": "application/octet-stream" },
    });
    assert.equal(put.status, 200, JSON.stringify(put.data));
  }
  assert.equal((await call(`uploads/${data.id}/complete`, { method: "POST" })).status, 200);
  return data.id;
}

// Guards
assert.equal((await call("text", { method: "POST", body: { text: "x" }, headers: { "Content-Type": "application/json" } })).status, 403);
assert.equal((await call("text", { method: "POST", body: { text: "x" }, headers: { ...jsonHeaders, Origin: "https://evil.example" } })).status, 403);

// Text and validation
const added = await call("text", { method: "POST", body: { text: "bonjour <b>" } });
assert.equal(added.status, 201);
assert.equal((await call("text", { method: "POST", body: { text: "  " } })).status, 400);
assert.equal((await call("text", { method: "POST", body: { text: "a".repeat(100_001) } })).status, 413);
const listed = await call("room");
assert.equal(listed.data.items.find((item) => item.id === added.data.id).text, "bonjour <b>");

// PIN on text: hidden in the list, wrong PIN counted, destroyed after five errors
const secret = await call("text", { method: "POST", body: { text: "caché", pin: "1234" } });
const lockedItem = (await call("room")).data.items.find((item) => item.id === secret.data.id);
assert.equal(lockedItem.locked, true);
assert.equal(lockedItem.text, undefined);
assert.equal((await call(`items/${secret.data.id}/unlock`, { method: "POST", body: { pin: "0000" } })).status, 403);
assert.equal((await call(`items/${secret.data.id}/unlock`, { method: "POST", body: { pin: "1234" } })).data.text, "caché");
for (let i = 0; i < 4; i++) await call(`items/${secret.data.id}/unlock`, { method: "POST", body: { pin: "0000" } });
assert.equal((await call(`items/${secret.data.id}/unlock`, { method: "POST", body: { pin: "1234" } })).status, 404);

// Upload rules
assert.equal((await call("uploads", { method: "POST", body: { name: "a.svg", size: 10, mime: "image/svg+xml" } })).status, 415);
assert.equal((await call("uploads", { method: "POST", body: { name: "a.png", size: 201 * 1024 * 1024, mime: "image/png" } })).status, 413);

// Multipart file over one chunk, then full and partial download
const size = 12 * 1024 * 1024;
const fileId = await postFile(size);
const full = await call(`items/${fileId}/file`);
assert.equal(full.status, 200);
assert.match(full.response.headers.get("content-disposition"), /^attachment/);
assert.equal(full.response.headers.get("x-content-type-options"), "nosniff");
assert.equal((await full.response.arrayBuffer()).byteLength, size);
const partial = await call(`items/${fileId}/file?inline=1`, { headers: { Range: "bytes=0-99" } });
assert.equal(partial.status, 206);
assert.equal(partial.response.headers.get("content-range"), `bytes 0-99/${size}`);

// Wrong part size is refused
const pending = await call("uploads", { method: "POST", body: { name: "b.png", size: 100, mime: "image/png" } });
const badPart = await call(`uploads/${pending.data.id}/1`, {
  method: "PUT",
  body: new Uint8Array(101),
  headers: { ...GUARD, "Content-Type": "application/octet-stream" },
});
assert.equal(badPart.status, 400);
assert.equal((await call(`uploads/${pending.data.id}/complete`, { method: "POST" })).status, 400);
await call(`items/${pending.data.id}`, { method: "DELETE" });

// Protected file needs a token
const lockedFile = await postFile(1000, "image/png", "4321");
assert.equal((await call(`items/${lockedFile}/file`)).status, 403);
const opened = await call(`items/${lockedFile}/unlock`, { method: "POST", body: { pin: "4321" } });
assert.equal((await call(`items/${lockedFile}/file?t=${encodeURIComponent(opened.data.token)}`)).status, 200);

// Code pairing, QR, unknown code
const code = await call("code", { method: "POST" });
assert.match(code.data.code, /^[A-HJKMNP-Z2-9]{6}$/);
assert.equal((await call(`qr?code=${code.data.code}`)).response.headers.get("content-type"), "image/svg+xml");
const join = await call("join", { method: "POST", body: { code: code.data.code } });
assert.equal(join.status, 200);
assert.match(join.response.headers.get("set-cookie"), /HttpOnly.*SameSite=Lax/);
assert.equal((await call("join", { method: "POST", body: { code: "ZZZZZZ" } })).status, 404);

// Deletion
assert.equal((await call(`items/${fileId}`, { method: "DELETE" })).status, 200);
assert.equal((await call(`items/${fileId}/file`)).status, 404);

console.log("smoke ok");
