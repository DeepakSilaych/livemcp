import { normalizeConnectionUrl, savedConnectionUrl } from "./connectionUrl.js";
import { BRIDGE_ACTIONS, isBridgeRequest, type BridgeAction, type BridgeResponse } from "@livemcp/shared";
import { dispatch } from "./handlers/index.js";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let socketGeneration = 0;
let keepAliveInterval: ReturnType<typeof setInterval> | undefined;

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ keepalive: true }));
    }
  }, 20_000);
}

function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = undefined;
  }
}

function isKnownAction(a: string): a is BridgeAction {
  return (BRIDGE_ACTIONS as readonly string[]).includes(a);
}

function send(res: BridgeResponse, source: WebSocket): number {
  if (socket === source && socket.readyState === WebSocket.OPEN) {
    const payload =
      res.error !== undefined
        ? { id: res.id, error: res.error }
        : { id: res.id, result: res.result === undefined ? null : res.result };
    const encoded = JSON.stringify(payload);
    socket.send(encoded);
    return new TextEncoder().encode(encoded).byteLength;
  }
  return 0;
}

const MAX_LOG_ENTRIES = 50;

type LogEntry = { action: string; ok: boolean; error?: string; ms: number; bytes?: number; ts: number };

async function appendLog(entry: LogEntry): Promise<void> {
  const { toolLog } = await chrome.storage.local.get(["toolLog"]);
  const log: LogEntry[] = Array.isArray(toolLog) ? toolLog : [];
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ toolLog: log });
}

async function handleMessage(raw: string, source: WebSocket): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isBridgeRequest(data)) return;
  if (!isKnownAction(data.action)) {
    send({ id: data.id, error: `Unknown action: ${data.action}` }, source);
    void appendLog({ action: data.action, ok: false, error: "Unknown action", ms: 0, ts: Date.now() });
    return;
  }
  const t0 = performance.now();
  try {
    const result = await dispatch(data.action, data.params ?? {});
    const ms = Math.round(performance.now() - t0);
    const bytes = send({ id: data.id, result }, source);
    void appendLog({ action: data.action, ok: true, ms, bytes, ts: Date.now() });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const msg = e instanceof Error ? e.message : String(e);
    send({ id: data.id, error: msg }, source);
    void appendLog({ action: data.action, ok: false, error: msg, ms, ts: Date.now() });
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(30_000, 1000 * 2 ** attempt);
  attempt += 1;
  reconnectTimer = setTimeout(() => void openSocket(), delay);
}

async function openSocket(): Promise<void> {
  const myGen = ++socketGeneration;
  stopKeepAlive();
  if (socket) { socket.close(); socket = null; }
  const store = await chrome.storage.local.get(['bridgeUserWantsConnect', 'wsUrl', 'wsPort', 'browserId', 'browserName', 'accessToken']);
  if (myGen !== socketGeneration || !store.bridgeUserWantsConnect) return;
  let url: string;
  try { url = normalizeConnectionUrl(savedConnectionUrl(store)); }
  catch (e) {
    await chrome.storage.local.set({ bridgeConnected: false, bridgeUserWantsConnect: false, bridgeLastError: String(e instanceof Error ? e.message : e) });
    return;
  }
  await chrome.storage.local.set({ bridgeConnected: false });
  if (myGen !== socketGeneration) return;
  const browserId = typeof store.browserId === 'string' ? store.browserId : crypto.randomUUID();
  if (!store.browserId) await chrome.storage.local.set({ browserId });
  if (myGen !== socketGeneration) return;
  const endpoint = new URL(url);
  if (store.accessToken && endpoint.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    await chrome.storage.local.set({ bridgeConnected: false, bridgeUserWantsConnect: false, bridgeLastError: 'Use wss:// for a remote hub with an access token.' });
    return;
  }
  const ws = new WebSocket(url);
  let ready = !store.accessToken;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  socket = ws;
  ws.onopen = () => {
    if (myGen !== socketGeneration) return;
    attempt = 0;
    ws.send(JSON.stringify({ type: 'hello', browserId, name: store.browserName || 'Chrome', token: store.accessToken || undefined }));
    startKeepAlive();
    void chrome.storage.local.set({ bridgeConnected: ready, bridgeLastError: "" });
    if (!ready) handshake = setTimeout(() => ws.close(1008, 'Hub did not acknowledge authentication'), 10000);
  };
  ws.onmessage = (ev) => {
    if (myGen !== socketGeneration || typeof ev.data !== 'string') return;
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg?.type === 'hello_ack') {
      clearTimeout(handshake); ready = true;
      void chrome.storage.local.set({ bridgeConnected: true, bridgeLastError: '' });
      return;
    }
    if (ready) void handleMessage(ev.data, ws);
  };
  ws.onerror = () => {
    if (myGen !== socketGeneration) return;
    void chrome.storage.local.set({
      bridgeConnected: false,
      bridgeLastError: "WebSocket error (is the MCP server running?)",
    });
  };
  ws.onclose = async (event) => {
    clearTimeout(handshake);
    if (myGen !== socketGeneration) return;
    stopKeepAlive();
    void chrome.storage.local.set({ bridgeConnected: false });
    socket = null;
    if (event.code === 1008) {
      await chrome.storage.local.set({ bridgeUserWantsConnect: false, bridgeLastError: event.reason || 'Hub rejected connection. Check your access token.' });
      return;
    }
    const { bridgeUserWantsConnect: want } = await chrome.storage.local.get(["bridgeUserWantsConnect"]);
    if (want && myGen === socketGeneration) scheduleReconnect();
  };
}

async function disconnectBridge(): Promise<void> {
  socketGeneration += 1;
  stopKeepAlive();
  await chrome.storage.local.set({
    bridgeUserWantsConnect: false,
    bridgeConnected: false,
    bridgeLastError: "",
  });
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  attempt = 0;
  if (socket) {
    socket.close();
    socket = null;
  }
}

async function connectBridge(url?: string, name?: string, token?: string): Promise<void> {
  const normalized = normalizeConnectionUrl(url ?? savedConnectionUrl(await chrome.storage.local.get(['wsUrl', 'wsPort'])));
  await chrome.storage.local.set({ wsUrl: normalized, ...(token !== undefined ? { accessToken: token.trim() } : {}), ...(name !== undefined ? { browserName: name.trim().slice(0,80) || "Chrome" } : {}), bridgeUserWantsConnect: true, bridgeLastError: "" });
  attempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  await openSocket();
}

void chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.wsUrl && !changes.wsPort) return;
  void chrome.storage.local.get(["bridgeUserWantsConnect"]).then(({ bridgeUserWantsConnect }) => {
    if (!bridgeUserWantsConnect) return;
    attempt = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    void openSocket();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && typeof msg === "object" && "type" in msg) {
    if (msg.type === "bridgeConnect") {
      void connectBridge(typeof msg.url === "string" ? msg.url : undefined, typeof msg.name === "string" ? msg.name : undefined, typeof msg.token === "string" ? msg.token : undefined).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true;
    }
    if (msg.type === "bridgeDisconnect") {
      void disconnectBridge().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "clearLog") {
      void chrome.storage.local.set({ toolLog: [] }).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
  return false;
});

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
// Restore the saved connection when Chrome restarts the service worker.
void openSocket();
