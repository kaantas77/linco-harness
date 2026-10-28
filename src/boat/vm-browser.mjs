/**
 * Runs inside one Boat VM. It never starts on the host.
 * Chrome uses an isolated profile under /home/user/linco.
 * DevTools stays on the parent pipe. There is no TCP debug port.
 * Web traffic goes through a loopback proxy that refuses private and metadata addresses.
 */
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { createConnection, createServer } from "node:net";

const PROFILE = "/home/user/linco/.linco/chrome-profile";
const SOCK = "/home/user/.linco/browser.sock";
const PROOF = "/home/user/linco/proof";

let engine = "starting";
let semantic = { snapshotId: 0, targetId: "", url: "", title: "", refs: new Map() };
let pwPage = null;
let chromeChild = null;
let pipeWrite = null;
let pipeReadBuf = "";
let sessionId = "";
let nextId = 0;
const pending = new Map();
let chain = Promise.resolve();
let egressPort = 0;

function chromeBin() {
  const real = ["/opt/google/chrome/chrome", "/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser"];
  const wrappers = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return real.find((bin) => existsSync(bin)) || wrappers.find((bin) => existsSync(bin)) || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPublic(raw) {
  const url = new URL(raw);
  if (url.protocol === "file:") {
    const filePath = decodeURIComponent(url.pathname);
    if (!filePath.startsWith("/home/user/linco/")) throw new Error("file URL is outside the workspace");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new Error("that host is blocked");
  }
  if (isPrivate(host)) throw new Error("that address is blocked");
}

function isPrivate(host) {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  const parts = ipv4.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function workspaceFile(relative) {
  if (!relative || typeof relative !== "string" || relative.includes("..") || relative.startsWith("/")) {
    throw new Error("path is outside the workspace");
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(relative)) throw new Error("path is outside the workspace");
  return `/home/user/linco/${relative}`;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function writeShot(name, buf) {
  mkdirSync(PROOF, { recursive: true });
  const relative = `proof/${name}.b64`;
  writeFileSync(`/home/user/linco/${relative}`, buf.toString("base64"));
  const size = pngSize(buf);
  return { shot: relative, bytes: buf.length, width: size.width, height: size.height };
}

async function resolvePublic(host) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!name || name === "localhost" || name.endsWith(".local") || name.endsWith(".internal") || isPrivate(name)) {
    throw new Error("that address is blocked");
  }
  if (net.isIP(name)) return name;
  const records = await lookup(name, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("that host did not resolve");
  for (const record of records) {
    if (isPrivate(record.address)) throw new Error("that host resolves to a blocked address");
  }
  return records[0].address;
}

function startEgress() {
  const server = http.createServer((request, response) => {
    forwardHttp(request, response).catch((error) => {
      if (response.headersSent) return;
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "blocked");
    });
  });
  server.on("connect", (request, socket) => {
    const [host, portText] = String(request.url || "").split(":");
    resolvePublic(host).then((address) => {
      const upstream = net.connect(Number(portText || 443), address, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.end());
    }).catch((error) => {
      const body = error instanceof Error ? error.message : "blocked";
      socket.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      egressPort = typeof address === "object" && address ? address.port : 0;
      resolve(egressPort);
    });
  });
}

async function forwardHttp(request, response) {
  const target = new URL(request.url || "");
  assertPublic(target.toString());
  const address = await resolvePublic(target.hostname);
  await new Promise((resolve, reject) => {
    const upstream = http.request({
      host: address,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (incoming) => {
      const location = incoming.headers.location;
      if (location && incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) {
        try {
          assertPublic(new URL(location, target).toString());
        } catch (error) {
          incoming.resume();
          reject(error);
          return;
        }
      }
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(response);
      incoming.on("end", resolve);
    });
    upstream.on("error", reject);
    request.pipe(upstream);
  });
}

function writePipe(json) {
  pipeWrite.write(`${json}\0`);
}

function consumePipe(chunk) {
  pipeReadBuf += chunk.toString("utf8");
  while (true) {
    const end = pipeReadBuf.indexOf("\0");
    if (end < 0) return;
    const raw = pipeReadBuf.slice(0, end);
    pipeReadBuf = pipeReadBuf.slice(end + 1);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!message.id || !pending.has(message.id)) continue;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "cdp error"));
    else waiter.resolve(message.result || {});
  }
}

async function ensureChrome() {
  if (chromeChild && !chromeChild.killed) return;
  if (!egressPort) await startEgress();
  const bin = chromeBin();
  if (!bin) throw new Error("google-chrome is not installed in the VM");
  mkdirSync(PROFILE, { recursive: true });
  chromeChild = spawn(bin, [
    `--user-data-dir=${PROFILE}`,
    "--remote-debugging-pipe",
    `--proxy-server=http://127.0.0.1:${egressPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=1100,800",
    "--window-position=40,80",
    "about:blank",
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  pipeWrite = chromeChild.stdio[3];
  chromeChild.stdio[4].on("data", consumePipe);
  chromeChild.stderr.on("data", (chunk) => process.stderr.write(chunk));
  chromeChild.on("exit", () => {
    chromeChild = null;
    pipeWrite = null;
  });
  await cdp("Browser.getVersion", {});
}

async function loadPlaywright() {
  const candidates = [
    "/home/user/linco/.linco/node_modules/playwright-core/index.js",
    "/home/user/linco/.linco/node_modules/playwright-core/index.mjs",
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return await import(candidate);
    } catch {
      /* try the CDP path */
    }
  }
  return null;
}

function cdp(method, params, session) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`cdp timeout ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const message = { id, method, params: params || {} };
    if (session) message.sessionId = session;
    writePipe(JSON.stringify(message));
  });
}

async function cdpAttach() {
  const targets = await cdp("Target.getTargets", {});
  const page = (targets.targetInfos || []).find((item) => item.type === "page");
  const targetId = page?.targetId || (await cdp("Target.createTarget", { url: "about:blank" })).targetId;
  const attached = await cdp("Target.attachToTarget", { targetId, flatten: true });
  sessionId = attached.sessionId;
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  engine = "cdp";
}

async function connectEngine() {
  await cdpAttach();
}

async function readCurrent(op) {
  if (engine === "playwright") {
    return {
      ok: true,
      engine,
      op,
      title: await pwPage.title(),
      url: pwPage.url(),
      text: (await pwPage.locator("body").innerText().catch(() => "")).slice(0, 4000),
    };
  }
  const value = await cdp("Runtime.evaluate", {
    expression: "(() => ({ title: document.title, url: location.href, text: (document.body && document.body.innerText || '').slice(0, 4000) }))()",
    returnByValue: true,
  }, sessionId);
  const data = value.result?.value || {};
  return { ok: true, engine, op, title: data.title || "", url: data.url || "", text: data.text || "" };
}

async function navigate(raw) {
  assertPublic(raw);
  if (engine === "playwright") {
    await pwPage.goto(raw, { waitUntil: "domcontentloaded", timeout: 20_000 });
    return;
  }
  await cdp("Page.navigate", { url: raw }, sessionId);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
    if (state.result?.value === "complete") return;
    await sleep(250);
  }
}

async function fillField(name, text, submit) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("field name is not allowed");
  if (typeof text !== "string" || text.length > 200) throw new Error("field text is too long");
  const selector = `input[name="${name}"], textarea[name="${name}"]`;
  if (engine === "playwright") {
    const field = pwPage.locator(selector).first();
    await field.fill(text);
    if (submit) {
      await Promise.all([
        pwPage.waitForURL(/\/post|example\.com/i, { timeout: 15_000 }).catch(() => undefined),
        pwPage.locator('button[type="submit"], input[type="submit"], button').first().click(),
      ]);
    }
    return;
  }
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(text)};
  })()`;
  const filled = await cdp("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (!filled.result?.value) throw new Error("form field was not filled");
  if (!submit) return;
  await cdp("Runtime.evaluate", {
    expression: "(() => { const button = document.querySelector('button[type=submit], input[type=submit], button'); if (button) button.click(); return true; })()",
    returnByValue: true,
  }, sessionId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await cdp("Runtime.evaluate", { expression: "document.readyState + location.href", returnByValue: true }, sessionId);
    if (String(state.result?.value || "").startsWith("complete") && !String(state.result?.value || "").includes("/forms/")) return;
    await sleep(250);
  }
}

async function pageShot() {
  if (engine === "playwright") {
    const buf = await pwPage.screenshot({ type: "png" });
    return writeShot("page-shot", buf);
  }
  const shot = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  return writeShot("page-shot", Buffer.from(shot.data, "base64"));
}

function grabDesktop() {
  mkdirSync(PROOF, { recursive: true });
  const out = `${PROOF}/desktop-shot.png`;
  const attempts = [
    ["gnome-screenshot", ["-f", out]],
    ["scrot", ["-o", out]],
    ["import", ["-window", "root", out]],
    ["ffmpeg", ["-y", "-f", "x11grab", "-video_size", "1280x800", "-i", ":0.0", "-frames:v", "1", out]],
  ];
  const errors = [];
  for (const [bin, args] of attempts) {
    const result = spawnSync(bin, args, {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
      timeout: 15_000,
    });
    if (result.status === 0 && existsSync(out) && readFileSync(out).length > 32) {
      const buf = readFileSync(out);
      return { captureTool: bin, ...writeShot("desktop-shot", buf) };
    }
    errors.push(`${bin}:${result.error?.code || result.status}`);
  }
  throw new Error(`desktop grab failed ${errors.join(" ")}`);
}

const USEFUL = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "tab", "menuitem", "switch"]);
const TAKEOVER = /\b(captcha|mfa|2fa|one[- ]time|password|passkey|verify you are human|doğrulama kodu|şifre)\b/i;

async function pageSocket() {
  const targets = await cdp("Target.getTargets", {});
  const page = (targets.targetInfos || []).find((item) => item.type === "page" && item.url !== "about:blank")
    || (targets.targetInfos || []).find((item) => item.type === "page");
  if (!page) throw new Error("no debuggable browser page");
  const attached = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  return {
    page: { id: page.targetId, url: page.url, title: page.title },
    send: (method, params = {}) => cdp(method, params, attached.sessionId),
    close: () => undefined,
  };
}

async function takeSnapshot() {
  const session = await pageSocket();
  try {
    await session.send("Accessibility.enable");
    await session.send("DOM.enable").catch(() => undefined);
    const tree = await session.send("Accessibility.getFullAXTree", { depth: 14 });
    const elements = [];
    const refs = new Map();
    for (const node of tree.nodes ?? []) {
      const role = String(node.role?.value ?? "").toLowerCase();
      const backend = Number(node.backendDOMNodeId ?? 0);
      const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (node.ignored || !USEFUL.has(role) || !backend) continue;
      if (!name && role !== "textbox" && role !== "searchbox") continue;
      const ref = `b${backend}`;
      const element = { ref, role, name: name || "unnamed", disabled: Boolean(node.properties?.some((property) => property.name === "disabled" && property.value?.value === true)) };
      if (role === "textbox" || role === "searchbox") element.filled = Boolean(String(node.value?.value ?? "").trim());
      elements.push(element);
      refs.set(ref, backend);
      if (elements.length >= 80) break;
    }
    if (elements.some((element) => TAKEOVER.test(element.name))) {
      throw new Error("USER_TAKEOVER_REQUIRED");
    }
    semantic = { snapshotId: semantic.snapshotId + 1, targetId: session.page.id, url: session.page.url, title: session.page.title || "", refs };
    return {
      snapshotId: semantic.snapshotId,
      targetId: semantic.targetId,
      url: semantic.url,
      title: semantic.title,
      elements,
    };
  } finally {
    session.close();
  }
}

function requireRef(payload) {
  if (!payload || payload.snapshotId !== semantic.snapshotId || !semantic.refs.has(payload.ref)) {
    throw new Error("that snapshot is stale — call browser_snapshot");
  }
  return semantic.refs.get(payload.ref);
}

async function listPages() {
  const targets = await cdp("Target.getTargets", {});
  return (targets.targetInfos || []).filter((item) => item.type === "page").map((item) => ({
    id: item.targetId,
    type: "page",
    url: item.url,
    title: item.title,
  }));
}

async function semanticClick(payload) {
  const backend = requireRef(payload);
  const before = semantic.url;
  const session = await pageSocket();
  try {
    if (session.page.id !== semantic.targetId) throw new Error("that snapshot is stale — call browser_snapshot");
    await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: backend }).catch(() => undefined);
    const box = await session.send("DOM.getBoxModel", { backendNodeId: backend });
    const quad = box.model?.content;
    if (!quad || quad.length < 8) throw new Error("element is not visible");
    const x = (quad[0] + quad[2]) / 2;
    const y = (quad[1] + quad[5]) / 2;
    if (x < 0 || y < 0 || x > 1400 || y > 1000) throw new Error("element is not visible");
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  } finally {
    session.close();
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(250);
    const pages = await listPages();
    const page = pages.find((item) => item.id === semantic.targetId) ?? pages.find((item) => item.type === "page");
    if (page?.url && page.url !== before && page.url !== "about:blank") break;
  }
  return takeSnapshot();
}

async function semanticFill(payload) {
  const backend = requireRef(payload);
  if (typeof payload.text !== "string" || payload.text.length > 200) throw new Error("field text is too long");
  const session = await pageSocket();
  try {
    if (session.page.id !== semantic.targetId) throw new Error("that snapshot is stale — call browser_snapshot");
    const resolved = await session.send("DOM.resolveNode", { backendNodeId: backend });
    const result = await session.send("Runtime.callFunctionOn", {
      objectId: resolved.object?.objectId,
      functionDeclaration: "function(text){ if(!this || this.disabled || this.readOnly) return false; this.focus(); this.value = text; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return typeof this.value === 'string' && this.value.length === text.length; }",
      arguments: [{ value: payload.text }],
      returnByValue: true,
    });
    if (!result.result?.value) throw new Error("form field was not filled");
  } finally {
    session.close();
  }
  return takeSnapshot();
}

async function semanticSelect(payload) {
  const backend = requireRef(payload);
  const value = String(payload.value ?? "");
  if (!value || value.length > 80) throw new Error("option is not allowed");
  const session = await pageSocket();
  try {
    if (session.page.id !== semantic.targetId) throw new Error("that snapshot is stale — call browser_snapshot");
    const resolved = await session.send("DOM.resolveNode", { backendNodeId: backend });
    const result = await session.send("Runtime.callFunctionOn", {
      objectId: resolved.object?.objectId,
      functionDeclaration: "function(value){ if(this.tagName!=='SELECT') return false; const option=[...this.options].find((item)=>item.label===value||item.value===value); if(!option||option.disabled) return false; this.value=option.value; this.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
      arguments: [{ value }],
      returnByValue: true,
    });
    if (!result.result?.value) throw new Error("option was not selected");
  } finally {
    session.close();
  }
  return takeSnapshot();
}

async function waitForPage(raw) {
  const expected = new URL(raw);
  let last = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pages = await listPages();
    const page = pages.find((item) => item.type === "page" && item.url && item.url !== "about:blank");
    if (page?.url) {
      assertPublic(page.url);
      last = page;
      const actual = new URL(page.url);
      const strip = (value) => value.toString().replace(/\/$/, "");
      const upgrade = expected.protocol === "http:" && actual.protocol === "https:" && expected.hostname === actual.hostname;
      if (strip(actual) === strip(expected) || actual.origin === expected.origin || upgrade) {
        return { page, match: strip(actual) === strip(expected) ? "exact" : "same-origin" };
      }
    }
    await sleep(250);
  }
  if (!last) throw new Error("navigation was not observed");
  return { page: last, match: "redirect" };
}

function snapshotResult(op, snapshot, extra = {}) {
  const text = snapshot.elements.map((element) => `${element.ref} ${element.role} ${element.name}`).join("\n");
  return { ok: true, engine, op, title: snapshot.title, url: snapshot.url, text, snapshot, ...extra };
}

async function handle(payload) {
  const op = payload?.op;
  if (op === "status") return { ok: true, engine, op };
  if (op === "hold") {
    await sleep(2_000);
    return { ok: true, engine, op };
  }
  if (op === "read") return readCurrent(op);
  if (op === "goto") {
    await navigate(payload.url);
    const current = await readCurrent(op);
    if (current.url) assertPublic(current.url);
    return current;
  }
  if (op === "navigate" || op === "openRead") {
    await navigate(payload.url);
    const current = await readCurrent(op);
    if (current.url) assertPublic(current.url);
    const waited = await waitForPage(payload.url);
    const snapshot = await takeSnapshot();
    const expectedTitle = typeof payload.expectedTitle === "string" ? payload.expectedTitle : "";
    const expectedText = typeof payload.expectedText === "string" ? payload.expectedText : "";
    const titleOk = !expectedTitle || snapshot.title === expectedTitle;
    const textOk = !expectedText || snapshot.elements.some((element) => element.name.includes(expectedText)) || (current.text ?? "").includes(expectedText);
    const verified = waited.match !== "redirect" && titleOk && textOk;
    if (op === "openRead" && !verified) throw new Error(`navigation not verified: ${snapshot.url} ${snapshot.title}`);
    return snapshotResult(op, snapshot, { verified, title: snapshot.title || current.title, text: `${current.text ?? ""}\n${snapshot.elements.map((element) => `${element.ref} ${element.role} ${element.name}`).join("\n")}`.trim() });
  }
  if (op === "fill") {
    await navigate(payload.url);
    await fillField(payload.name, payload.text, payload.submit === true);
    return readCurrent(op);
  }
  if (op === "snapshot") return snapshotResult(op, await takeSnapshot());
  if (op === "clickRef") return snapshotResult(op, await semanticClick(payload));
  if (op === "fillRef") return snapshotResult(op, await semanticFill(payload));
  if (op === "selectRef") return snapshotResult(op, await semanticSelect(payload));
  if (op === "showFile") {
    const file = workspaceFile(payload.relative);
    let openPath = file;
    if (file.endsWith(".b64")) {
      openPath = file.replace(/\.b64$/, ".png");
      writeFileSync(openPath, Buffer.from(readFileSync(file, "utf8"), "base64"));
    }
    await navigate(`file://${openPath}`);
    const shot = await pageShot();
    return { ...(await readCurrent(op)), ...shot };
  }
  if (op === "screenshot") return { ok: true, engine, op, ...(await pageShot()) };
  if (op === "grab") return { ok: true, engine, op, ...grabDesktop() };
  throw new Error("unknown browser op");
}

function enqueue(work) {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

function serve() {
  ensureChrome()
    .then(() => connectEngine())
    .then(() => {
      mkdirSync("/home/user/.linco", { recursive: true, mode: 0o700 });
      rmSync(SOCK, { force: true });
      const server = createServer((socket) => {
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          if (!buf.includes("\n")) return;
          const line = buf.slice(0, buf.indexOf("\n"));
          buf = "";
          enqueue(() => handle(JSON.parse(line)))
            .then((result) => {
              socket.write(`${JSON.stringify(result)}\n`);
              socket.end();
            })
            .catch((error) => {
              socket.write(`${JSON.stringify({ ok: false, engine, error: error instanceof Error ? error.message : String(error) })}\n`);
              socket.end();
            });
        });
      });
      server.listen(SOCK);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}

function talk(payload, timeoutMs) {
  const socket = createConnection(SOCK);
  let data = "";
  const timer = setTimeout(() => {
    socket.destroy();
    process.exit(1);
  }, timeoutMs);
  socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
  socket.on("data", (chunk) => {
    data += chunk.toString("utf8");
  });
  socket.on("error", () => process.exit(1));
  socket.on("end", () => {
    clearTimeout(timer);
    process.stdout.write(data);
    process.exit(data.includes('"ok":true') ? 0 : 1);
  });
}

const mode = process.argv[2];
if (mode === "ping") talk({ op: "status" }, 1_500);
else if (mode === "serve") serve();
else if (mode === "call") talk(JSON.parse(Buffer.from(process.argv[3] || "", "base64").toString("utf8")), 45_000);
else {
  process.stderr.write("vm browser mode is missing\n");
  process.exit(1);
}
