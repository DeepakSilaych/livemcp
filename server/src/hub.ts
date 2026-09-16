import { createServer as createNetServer, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { isBridgeResponse, DEFAULT_WS_PORT } from '@livemcp/shared';
export const HUB_SOCK = process.env.LIVEMCP_HUB_SOCK ?? '/tmp/livemcp-hub.sock';
const host = process.env.LIVEMCP_HOST ?? '127.0.0.1';
const basePort = Number(process.env.LIVEMCP_PORT ?? DEFAULT_WS_PORT) || DEFAULT_WS_PORT;
type Browser = { id: string; name: string; ws: WebSocket; connectedAt: string; legacy: boolean };
type Session = { sock: Socket; browserId?: string };
const browsers = new Map<string, Browser>(), sessions = new Map<string, Session>();
const pending = new Map<string, { sessionId: string; requestId: string; browser: Browser; timer: ReturnType<typeof setTimeout> }>();
function send(sessionId: string, msg: object) { const s = sessions.get(sessionId); if (s && !s.sock.destroyed) s.sock.write(JSON.stringify(msg) + '\n'); }
function finish(id: string, error?: string) {
  const p = pending.get(id); if (!p) return;
  clearTimeout(p.timer); pending.delete(id);
  if (error) send(p.sessionId, { type: 'response', id: p.requestId, error });
}
function clearSession(sessionId: string) { for (const [id,p] of pending) if (p.sessionId === sessionId) finish(id); }
function listBrowsers() { return [...browsers.values()].filter(b => b.ws.readyState === WebSocket.OPEN).map(({ id, name, connectedAt, legacy }) => ({ id, name, connectedAt, legacy })); }
function status(sessionId: string) { const s = sessions.get(sessionId); send(sessionId, { type: 'status', connected: listBrowsers().length > 0, browserId: s?.browserId }); }
function broadcast() { for (const id of sessions.keys()) status(id); }
function removeBrowser(browser: Browser, error: string) {
  if (browsers.get(browser.id) !== browser) return;
  browsers.delete(browser.id);
  for (const [id,p] of pending) if (p.browser === browser) finish(id, error);
  broadcast();
}
let activeWss: WebSocketServer | null = null;
function startWss(port: number) {
  const wss = new WebSocketServer({ host, port });
  wss.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') { wss.close(); startWss(port + 1); return; }
    process.stderr.write(`[livemcp-hub] ${err.message}\n`); process.exit(1);
  });
  wss.once('listening', () => {
    activeWss = wss;
    process.stderr.write(`[livemcp-hub] IPC socket : ${HUB_SOCK}\n[livemcp-hub] WebSocket : ws://${host.includes(':') ? `[${host}]` : host}:${port}\n[livemcp-hub] Ready — multiple browsers supported\n`);
  });
  wss.on('connection', ws => {
    // Older extensions remain usable with an ephemeral connection identity.
    let browser: Browser = { id: `legacy-${randomUUID()}`, name: 'Browser (legacy extension)', ws, connectedAt: new Date().toISOString(), legacy: true };
    browsers.set(browser.id, browser); broadcast();
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25000);
    ws.on('message', raw => {
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'hello' && typeof msg.browserId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(msg.browserId)) {
        if (!browser.legacy && browser.id !== msg.browserId) { ws.close(1008, 'Browser identity cannot change on a connection'); return; }
        const id = msg.browserId;
        if (browser.id !== id) {
          browsers.delete(browser.id);
          // A legacy auto-pin issued before hello belongs to this connection.
          for (const s of sessions.values()) if (s.browserId === browser.id) s.browserId = id;
          const prior = browsers.get(id);
          if (prior && prior !== browser) { removeBrowser(prior, 'Browser reconnected; action outcome may be unknown.'); prior.ws.close(); }
          browser.id = id;
        }
        browser.name = typeof msg.name === 'string' ? msg.name.slice(0,80) : 'Chrome';
        browser.legacy = false; browsers.set(id, browser); broadcast(); return;
      }
      if (!isBridgeResponse(msg)) return;
      const entry = pending.get(msg.id);
      if (!entry || entry.browser !== browser || browsers.get(browser.id) !== browser) return;
      finish(msg.id); send(entry.sessionId, { type: 'response', id: entry.requestId, result: msg.result, error: msg.error });
    });
    const cleanup = () => { clearInterval(ping); removeBrowser(browser, 'Extension disconnected; action outcome may be unknown.'); };
    ws.on('close', cleanup); ws.on('error', cleanup);
  });
}
if (existsSync(HUB_SOCK)) { try { unlinkSync(HUB_SOCK); } catch {} }
const ipcServer = createNetServer(sock => {
  sock.setEncoding('utf8'); let buffer = '';
  sock.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { sock.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end + 1);
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg.sessionId !== 'string') continue;
      if (msg.type === 'register') {
        const existing = sessions.get(msg.sessionId);
        if (existing && existing.sock !== sock) continue;
        sessions.set(msg.sessionId, { sock, browserId: typeof msg.browserId === 'string' ? msg.browserId : undefined });
        send(msg.sessionId, { type: 'registered', sessionId: msg.sessionId }); status(msg.sessionId); continue;
      }
      const session = sessions.get(msg.sessionId); if (!session || session.sock !== sock) continue;
      if (msg.type === 'unregister') { clearSession(msg.sessionId); sessions.delete(msg.sessionId); continue; }
      if (msg.type === 'cancel') { for (const [id,p] of pending) if (p.sessionId === msg.sessionId && p.requestId === msg.id) finish(id); continue; }
      if (msg.type !== 'request' || typeof msg.id !== 'string') continue;
      const reply = (result?: unknown, error?: string) => send(msg.sessionId, { type: 'response', id: msg.id, result, error });
      if (msg.action === 'hub.listBrowsers') { reply({ browsers: listBrowsers(), selectedBrowserId: session.browserId ?? null }); continue; }
      if (msg.action === 'hub.selectBrowser') {
        const id = msg.params?.browserId;
        if (typeof id !== 'string' || !browsers.has(id)) { reply(undefined, 'Browser unavailable. Call list_browsers for connected browsers.'); continue; }
        session.browserId = id; status(msg.sessionId); reply({ browserId: id, name: browsers.get(id)!.name }); continue;
      }
      if (!session.browserId) {
        const list = listBrowsers();
        if (list.length === 1) { session.browserId = list[0].id; status(msg.sessionId); }
        else { reply(undefined, list.length ? 'Multiple browsers connected. Call list_browsers then select_browser before using tabs.' : 'Chrome extension not connected to hub'); continue; }
      }
      const browser = browsers.get(session.browserId);
      if (!browser || browser.ws.readyState !== WebSocket.OPEN) { reply(undefined, 'Selected browser disconnected. Reconnect it or explicitly select_browser; no fallback to another browser.'); continue; }
      if (pending.size >= 1000) { reply(undefined, 'Hub busy; retry later.'); continue; }
      const id = randomUUID(); // Request IDs are unique across agent sessions.
      pending.set(id, { sessionId: msg.sessionId, requestId: msg.id, browser, timer: setTimeout(() => finish(id, 'Bridge deadline exceeded; inspect state before retrying.'), 29000) });
      browser.ws.send(JSON.stringify({ id, action: msg.action, params: { ...msg.params, __deadline: Date.now() + 28000 } }));
    }
  });
  sock.on('close', () => { for (const [id,s] of sessions) if (s.sock === sock) { clearSession(id); sessions.delete(id); } });
  sock.on('error', () => {});
});
ipcServer.listen(HUB_SOCK);
function shutdown() { ipcServer.close(); activeWss?.close(); try { unlinkSync(HUB_SOCK); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
startWss(basePort);
