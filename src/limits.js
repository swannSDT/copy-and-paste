export const TTL_MS = 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const JOIN_COOKIE_TTL_MS = 60 * 60 * 1000;
export const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;

export const MAX_TEXT_CHARS = 100_000;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const CHUNK_BYTES = 10 * 1024 * 1024;
export const MAX_ROOM_ITEMS = 50;
export const MAX_ROOM_BYTES = 2 * 1024 * 1024 * 1024;

export const MAX_PIN_TRIES = 5;
export const MAX_JOIN_FAILURES = 10;
export const JOIN_WINDOW_MS = 60 * 60 * 1000;

// SVG and HTML are left out on purpose: both can run scripts when opened.
export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
