type NetRecord = {
  requestId: string;
  url?: string;
  method?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  body?: string;
  mimeType?: string;
};

type LogRecord = { text: string; level?: string; source?: string };

type TabCapture = {
  networkOn: boolean;
  consoleOn: boolean;
  requests: Map<string, NetRecord>;
  logs: LogRecord[];
  droppedRequests: number;
  droppedLogs: number;
};

const tabState = new Map<number, TabCapture>();
const attachedTabs = new Set<number>();
const attaching = new Map<number, Promise<void>>();
const inflight = new Map<number, Set<string>>();
const activity = new Map<number, number>();
const automationTabs = new Set<number>();

function getState(tabId: number): TabCapture {
  let s = tabState.get(tabId);
  if (!s) {
    s = { networkOn: false, consoleOn: false, requests: new Map(), logs: [], droppedRequests: 0, droppedLogs: 0 };
    tabState.set(tabId, s);
  }
  return s;
}

function sendDebuggerCommand(tabId: number, method: string, commandParams?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, commandParams ?? {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function attachOnce(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  attachedTabs.add(tabId);
  await sendDebuggerCommand(tabId, "Network.enable", {});
  await sendDebuggerCommand(tabId, "Log.enable", {});
  await sendDebuggerCommand(tabId, "Runtime.enable", {});
}

async function attachTab(tabId: number): Promise<void> {
  bindListener(); getState(tabId);
  if (attachedTabs.has(tabId)) return;
  let task = attaching.get(tabId);
  if (!task) { task = attachOnce(tabId).finally(() => attaching.delete(tabId)); attaching.set(tabId, task); }
  return task;
}
export async function ensureDebugger(tabId: number) { automationTabs.add(tabId); await attachTab(tabId); }
/** Never replay a failed input command: it may already have reached the page. */
export async function command(tabId: number, method: string, params: object = {}): Promise<any> {
  await ensureDebugger(tabId);
  return sendDebuggerCommand(tabId, method, params);
}
export function debuggerHealth(tabId: number) { return { attached: attachedTabs.has(tabId), pendingRequests: inflight.get(tabId)?.size ?? 0 }; }
export async function resetDebugger(tabId: number) {
  const st = getState(tabId), networkOn = st.networkOn, consoleOn = st.consoleOn;
  await detachTab(tabId); await attachTab(tabId); st.networkOn = networkOn; st.consoleOn = consoleOn; return debuggerHealth(tabId);
}
export async function waitNetworkIdle(tabId: number, timeout: number, quietMs = 500): Promise<any> {
  await command(tabId, 'Network.enable');
  const started = Date.now(), deadline = started + timeout;
  while (Date.now() < deadline) {
    if (!attachedTabs.has(tabId)) throw new Error('DEBUGGER_DETACHED: Network idle observation interrupted.');
    if (!(inflight.get(tabId)?.size) && Date.now() - Math.max(started, activity.get(tabId) ?? 0) >= quietMs) return { ready: true, waitedMs: Date.now() - started, quietMs };
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error('WAIT_TIMEOUT: Network did not become idle. Long polling can prevent idle; prefer text or URL readiness.');
}

async function detachTab(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
  attachedTabs.delete(tabId);
}

let boundDebugger: typeof chrome.debugger | undefined;

function bindListener(): void {
  if (boundDebugger === chrome.debugger) return;
  boundDebugger = chrome.debugger;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    const st = tabState.get(tabId);
    if (!st) return;
    if (method === 'Network.requestWillBeSent') {
      const p = params as any;
      // Streaming connections do not define page readiness.
      if (!['WebSocket','EventSource'].includes(p.type)) {
        const requests = inflight.get(tabId) ?? new Set<string>(); requests.add(p.requestId); inflight.set(tabId, requests); activity.set(tabId, Date.now());
      }
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      inflight.get(tabId)?.delete((params as any).requestId); activity.set(tabId, Date.now());
    }
    if (st.networkOn && method === "Network.requestWillBeSent") {
      const p = params as { requestId: string; request?: { url: string; method: string } };
      const cur = st.requests.get(p.requestId) ?? { requestId: p.requestId };
      cur.url = p.request?.url?.slice(0, 2048);
      cur.method = p.request?.method;
      st.requests.set(p.requestId, cur);
      if (st.requests.size > 500) { st.requests.delete(st.requests.keys().next().value!); st.droppedRequests++; }
    }
    if (st.networkOn && method === "Network.responseReceived") {
      const p = params as {
        requestId: string;
        response?: { status: number; headers?: Record<string, string>; mimeType?: string };
      };
      const cur = st.requests.get(p.requestId) ?? { requestId: p.requestId };
      cur.status = p.response?.status;
      cur.mimeType = p.response?.mimeType;
      st.requests.set(p.requestId, cur);
      if (st.requests.size > 500) { st.requests.delete(st.requests.keys().next().value!); st.droppedRequests++; }
    }
    if (st.consoleOn && method === "Log.entryAdded") {
      const p = params as { entry?: { text?: string; level?: string; source?: string } };
      st.logs.push({
        text: (p.entry?.text ?? "").slice(0, 2000),
        level: p.entry?.level,
        source: p.entry?.source,
      });
    }
    if (st.consoleOn && method === "Runtime.consoleAPICalled") {
      const p = params as {
        type?: string;
        args?: { type?: string; value?: unknown; description?: string }[];
      };
      const text = (p.args ?? [])
        .map((a) => {
          if (a.value !== undefined) return String(a.value);
          if (a.description) return a.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      st.logs.push({ text: text.slice(0, 2000), level: p.type, source: "console.api" });
    }
    if (st.logs.length > 500) { st.droppedLogs += st.logs.length - 500; st.logs.splice(0, st.logs.length - 500); }
  });
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (tabId != null) {
      attachedTabs.delete(tabId); inflight.delete(tabId); activity.delete(tabId);
      // Keep bounded records readable after capture stops.
      const st = tabState.get(tabId);
      if (st) { st.networkOn = false; st.consoleOn = false; }
    }
  });
  chrome.tabs.onRemoved.addListener(id => { tabState.delete(id); attachedTabs.delete(id); inflight.delete(id); activity.delete(id); automationTabs.delete(id); });
}

export async function getBody(tabId: number, requestId: string, maxChars = 12000): Promise<unknown> {
  const record = tabState.get(tabId)?.requests.get(requestId);
  if (!record) throw new Error('Request missing or evicted from capture buffer.');
  if (record.mimeType && !/text|json|xml|javascript|graphql/.test(record.mimeType)) return { requestId, omitted: 'Non-text response', mimeType: record.mimeType };
  const raw = await sendDebuggerCommand(tabId, 'Network.getResponseBody', { requestId }) as { body: string; base64Encoded: boolean };
  const limit = Math.min(50000, Math.max(100, maxChars));
  return { requestId, body: raw.base64Encoded ? '[binary omitted]' : raw.body.slice(0, limit), truncated: raw.body.length > limit, totalChars: raw.body.length };
}

export async function startNetwork(tabId: number): Promise<{ ok: true }> {
  bindListener();
  const st = getState(tabId);
  st.networkOn = true;
  st.requests.clear(); st.droppedRequests = 0;
  await attachTab(tabId);
  return { ok: true };
}

export async function stopNetwork(tabId: number): Promise<{ ok: true }> {
  const st = tabState.get(tabId);
  if (st) {
    st.networkOn = false;
    if (!st.consoleOn && !automationTabs.has(tabId)) {
      await detachTab(tabId);
    }
  }
  return { ok: true };
}

export function getNetwork(tabId: number, clearAfter: boolean, options: Record<string, unknown> = {}): unknown {
  const st = tabState.get(tabId);
  const filtered = [...(st?.requests.values() ?? [])].filter(r => !options.url || r.url?.includes(String(options.url)));
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? 50)));
  const offset = Math.max(0, Number(options.offset ?? 0));
  const requests: NetRecord[] = [];
  let chars = 0;
  for (const { responseHeaders: _headers, body: _body, ...entry } of filtered.slice(offset, offset + limit)) {
    const size = JSON.stringify(entry).length;
    if (chars + size > 12000) break;
    requests.push(entry); chars += size;
  }
  if (clearAfter && st) for (const r of requests) st.requests.delete(r.requestId);
  return { requests, total: filtered.length, truncated: filtered.length > offset + requests.length, nextOffset: filtered.length > offset + requests.length ? (clearAfter ? offset : offset + requests.length) : null, dropped: st?.droppedRequests ?? 0 };
}

export async function startConsole(tabId: number): Promise<{ ok: true }> {
  bindListener();
  const st = getState(tabId);
  st.consoleOn = true;
  st.logs = []; st.droppedLogs = 0;
  await attachTab(tabId);
  return { ok: true };
}

export async function stopConsole(tabId: number): Promise<{ ok: true }> {
  const st = tabState.get(tabId);
  if (st) {
    st.consoleOn = false;
    if (!st.networkOn && !automationTabs.has(tabId)) {
      await detachTab(tabId);
    }
  }
  return { ok: true };
}

export function getConsole(tabId: number, clearAfter: boolean, options: Record<string, unknown> = {}): unknown {
  const st = tabState.get(tabId), all = st?.logs ?? [];
  const filtered = all.filter(l => !options.level || l.level === options.level);
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? 50))), offset = Math.max(0, Number(options.offset ?? 0));
  const logs: LogRecord[] = [];
  let chars = 0;
  for (const entry of filtered.slice(offset, offset + limit)) {
    if (chars + entry.text.length > 12000) break;
    logs.push(entry); chars += entry.text.length;
  }
  if (clearAfter && st) { const read = new Set(logs); st.logs = all.filter(l => !read.has(l)); }
  return { logs, total: filtered.length, truncated: filtered.length > offset + logs.length, nextOffset: filtered.length > offset + logs.length ? (clearAfter ? offset : offset + logs.length) : null, dropped: st?.droppedLogs ?? 0 };
}
