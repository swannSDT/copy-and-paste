const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64Url(new Uint8Array(signature));
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Signed value: "<payload>.<expiry>.<signature>". The payload must not contain a dot.
export async function signValue(secret, purpose, payload, expiresAt) {
  const signature = await hmac(secret, `${purpose}:${payload}.${expiresAt}`);
  return `${payload}.${expiresAt}.${signature}`;
}

export async function verifyValue(secret, purpose, value) {
  const parts = String(value ?? "").split(".");
  if (parts.length !== 3) return null;
  const [payload, expiresAt, signature] = parts;
  if (Number(expiresAt) < Date.now()) return null;
  const expected = await hmac(secret, `${purpose}:${payload}.${expiresAt}`);
  return safeEqual(signature, expected) ? payload : null;
}
