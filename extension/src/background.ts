import { BRIDGE_ACTIONS, DEFAULT_WS_PORT, isBridgeRequest, type BridgeAction, type BridgeResponse } from "@livemcp/shared";
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

async function readPort(): Promise<number> {
  const { wsPort } = await chrome.storage.local.get(["wsPort"]);
  return typeof wsPort === "number" && wsPort > 0 && wsPort < 65536 ? wsPort : DEFAULT_WS_PORT;
}

function send(res: BridgeResponse): number {
  if (socket && socket.readyState === WebSocket.OPEN) {
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

async function handleMessage(raw: string): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isBridgeRequest(data)) return;
  if (!isKnownAction(data.action)) {
    send({ id: data.id, error: `Unknown action: ${data.action}` });
    void appendLog({ action: data.action, ok: false, error: "Unknown action", ms: 0, ts: Date.now() });
    return;
  }
  const t0 = performance.now();
  try {
    const result = await dispatch(data.action, data.params ?? {});
    const ms = Math.round(performance.now() - t0);
    const bytes = send({ id: data.id, result });
    void appendLog({ action: data.action, ok: true, ms, bytes, ts: Date.now() });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const msg = e instanceof Error ? e.message : String(e);
    send({ id: data.id, error: msg });
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
  const { bridgeUserWantsConnect } = await chrome.storage.local.get(["bridgeUserWantsConnect"]);
  if (!bridgeUserWantsConnect) return;

  const port = await readPort();
  const url = `ws://127.0.0.1:${port}`;
  if (socket) {
    socket.close();
    socket = null;
  }
  const myGen = ++socketGeneration;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    if (myGen !== socketGeneration) return;
    attempt = 0;
    startKeepAlive();
    void chrome.storage.local.set({ bridgeConnected: true, bridgeLastError: "" });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") void handleMessage(ev.data);
  };
  ws.onerror = () => {
    if (myGen !== socketGeneration) return;
    void chrome.storage.local.set({
      bridgeConnected: false,
      bridgeLastError: "WebSocket error (is the MCP server running?)",
    });
  };
  ws.onclose = async () => {
    if (myGen !== socketGeneration) return;
    stopKeepAlive();
    void chrome.storage.local.set({ bridgeConnected: false });
    socket = null;
    const { bridgeUserWantsConnect: want } = await chrome.storage.local.get(["bridgeUserWantsConnect"]);
    if (want) scheduleReconnect();
  };
}

async function disconnectBridge(): Promise<void> {
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
  socketGeneration += 1;
  if (socket) {
    socket.close();
    socket = null;
  }
}

async function connectBridge(): Promise<void> {
  await chrome.storage.local.set({ bridgeUserWantsConnect: true, bridgeLastError: "" });
  attempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  await openSocket();
}

void chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.wsPort) return;
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
      void connectBridge().then(() => sendResponse({ ok: true }));
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
