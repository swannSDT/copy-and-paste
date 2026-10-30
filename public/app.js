const MAX_FILE_BYTES = 200 * 1024 * 1024;
const ALLOWED_TYPES = new Set(document.querySelector("#files").accept.split(","));

const $ = (selector) => document.querySelector(selector);
const textInput = $("#text");
const pinInput = $("#pin");
const errorBox = $("#error");
const statusBox = $("#status");
const list = $("#items");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const isJson = body !== undefined && !(body instanceof Blob);
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      headers: {
        "X-Requested-With": "copy-and-paste",
        ...(isJson ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: isJson ? JSON.stringify(body) : body,
    });
  } catch {
    throw new Error("Pas de connexion. Vérifie ton réseau et réessaie.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Une erreur est survenue. Réessaie.");
  return data;
}

function readPin() {
  const pin = pinInput.value.trim();
  if (pin && !/^\d{4,8}$/.test(pin)) throw new Error("Le PIN doit contenir 4 à 8 chiffres.");
  return pin;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

function minutesLeft(expiresAt) {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
  return `Expire dans ${minutes} min`;
}

function button(label, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function renderText(container, text) {
  const pre = document.createElement("pre");
  pre.textContent = text;
  const copy = button("Copier", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copié";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copy.textContent = "Sélectionné, copie à la main";
    }
    setTimeout(() => (copy.textContent = "Copier"), 2000);
  });
  container.replaceChildren(pre, copy);
}

function renderFile(container, item, token) {
  const query = token ? `t=${encodeURIComponent(token)}&` : "";
  const base = `/api/items/${encodeURIComponent(item.id)}/file?${query}`;
  const nodes = [];

  if (item.mime.startsWith("image/") && !item.mime.includes("hei")) {
    const image = document.createElement("img");
    image.src = `${base}inline=1`;
    image.alt = item.name;
    image.loading = "lazy";
    nodes.push(image);
  } else if (item.mime.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = `${base}inline=1`;
    video.controls = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", item.name);
    nodes.push(video);
  }

  const name = document.createElement("p");
  name.className = "file-name";
  name.textContent = `${item.name} (${formatSize(item.size)})`;
  const download = document.createElement("a");
  download.className = "download";
  download.href = base;
  download.textContent = "Télécharger";
  container.replaceChildren(...nodes, name, download);
}

function renderLocked(container, item) {
  const form = document.createElement("form");
  form.className = "unlock";
  const label = document.createElement("label");
  label.textContent = "Contenu protégé par PIN";
  const input = document.createElement("input");
  input.type = "password";
  input.inputMode = "numeric";
  input.maxLength = 8;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "PIN");
  const submit = document.createElement("button");
  submit.textContent = "Ouvrir";
  const message = document.createElement("p");
  message.className = "error";
  message.hidden = true;
  label.append(input);
  form.append(label, submit, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const opened = await api(`items/${encodeURIComponent(item.id)}/unlock`, {
        method: "POST",
        body: { pin: input.value.trim() },
      });
      unlocked.set(item.id, opened);
      if (opened.kind === "text") renderText(container, opened.text);
      else renderFile(container, { ...opened, id: item.id }, opened.token);
    } catch (error) {
      message.textContent = error.message;
      message.hidden = false;
      submit.disabled = false;
    }
  });
  container.replaceChildren(form);
}

// Survives list refreshes, so an opened item does not ask for its PIN again.
const unlocked = new Map();
const renderedKeys = new Map();

function renderItems(items) {
  $("#empty").hidden = items.length > 0;
  const ids = new Set(items.map((item) => item.id));
  for (const [id, node] of renderedKeys) {
    if (!ids.has(id)) {
      node.remove();
      renderedKeys.delete(id);
      unlocked.delete(id);
    }
  }
  items.forEach((item, index) => {
    let node = renderedKeys.get(item.id);
    if (!node) {
      node = $("#item-template").content.firstElementChild.cloneNode(true);
      const body = node.querySelector(".item-body");
      if (item.locked) renderLocked(body, item);
      else if (item.kind === "text") renderText(body, item.text);
      else renderFile(body, item);
      node.querySelector(".delete").addEventListener("click", async () => {
        try {
          await api(`items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          await refresh();
        } catch (error) {
          showError(error.message);
        }
      });
      renderedKeys.set(item.id, node);
    }
    node.querySelector(".expiry").textContent = minutesLeft(item.expiresAt);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
}

async function refresh() {
  const data = await api("room");
  renderItems(data.items);
  statusBox.textContent = data.joined ? "Relié par code" : "Ton réseau";
  $("#leave").hidden = !data.joined;
}

async function sendText() {
  showError("");
  const sendButton = $("#send");
  const text = textInput.value;
  try {
    if (!text.trim()) throw new Error("Colle d'abord un texte.");
    const pin = readPin();
    sendButton.disabled = true;
    sendButton.textContent = "Envoi…";
    await api("text", { method: "POST", body: { text, pin } });
    textInput.value = "";
    await refresh();
  } catch (error) {
    showError(error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = "Partager le texte";
  }
}

async function uploadPart(id, number, blob) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api(`uploads/${id}/${number}`, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function uploadFile(file, pin) {
  if (!ALLOWED_TYPES.has(file.type)) throw new Error(`${file.name} : seules les images et les vidéos sont acceptées.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} : 200 Mo maximum.`);

  const label = $("#progress-label");
  const bar = $("#progress-bar");
  label.textContent = `Envoi de ${file.name}`;
  bar.value = 0;

  const { id, chunkSize } = await api("uploads", {
    method: "POST",
    body: { name: file.name, size: file.size, mime: file.type, pin },
  });
  const total = Math.ceil(file.size / chunkSize);
  try {
    for (let number = 1; number <= total; number++) {
      await uploadPart(id, number, file.slice((number - 1) * chunkSize, number * chunkSize));
      bar.value = (number / total) * 100;
    }
    await api(`uploads/${id}/complete`, { method: "POST" });
  } catch (error) {
    await api(`items/${id}`, { method: "DELETE" }).catch(() => {});
    throw new Error(`${file.name} : ${error.message}`);
  }
}

async function uploadFiles(files) {
  if (!files.length) return;
  showError("");
  const progress = $("#progress");
  try {
    const pin = readPin();
    progress.hidden = false;
    for (const file of files) await uploadFile(file, pin);
    await refresh();
  } catch (error) {
    showError(error.message);
  } finally {
    progress.hidden = true;
    $("#files").value = "";
  }
}

async function makeCode() {
  showError("");
  try {
    const { code } = await api("code", { method: "POST" });
    $("#code").textContent = code;
    $("#qr").src = `/api/qr?code=${encodeURIComponent(code)}`;
    $("#code-box").hidden = false;
  } catch (error) {
    showError(error.message);
  }
}

async function join(code) {
  showError("");
  try {
    await api("join", { method: "POST", body: { code } });
    location.hash = "";
    await refresh();
    connectSocket(true);
  } catch (error) {
    showError(error.message);
  }
}

let socket;
let retryDelay = 1000;

function connectSocket(force = false) {
  if (force && socket) {
    socket.onclose = null;
    socket.close();
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
  socket.onopen = () => {
    retryDelay = 1000;
    refresh().catch((error) => showError(error.message));
  };
  socket.onmessage = () => refresh().catch(() => {});
  socket.onclose = () => {
    statusBox.textContent = "Connexion perdue, nouvel essai…";
    setTimeout(connectSocket, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };
}

$("#send").addEventListener("click", sendText);
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendText();
});
$("#files").addEventListener("change", (event) => uploadFiles([...event.target.files]));
$("#make-code").addEventListener("click", makeCode);
$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  join($("#join-code").value);
});
$("#leave").addEventListener("click", async () => {
  try {
    await api("leave", { method: "POST" });
    await refresh();
    connectSocket(true);
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    uploadFiles(files);
  }
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  uploadFiles([...event.dataTransfer.files]);
});

setInterval(() => refresh().catch(() => {}), 60000);

const sharedCode = /^#c=([A-Za-z0-9]{6})$/.exec(location.hash)?.[1];
if (sharedCode) await join(sharedCode);
connectSocket();
