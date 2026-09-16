import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage } from 'node:http';
import { chmodSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { DEFAULT_WS_PORT } from '@livemcp/shared';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { BrowserRouter, validHello } from './router.js';
import { createMcpServer } from './mcp-server.js';
import type { Bridge } from './bridge.js';

export const HUB_SOCK = process.env.LIVEMCP_HUB_SOCK ?? '/tmp/livemcp-hub.sock';
const host = process.env.LIVEMCP_HOST ?? '127.0.0.1';
const port = Number(process.env.LIVEMCP_PORT ?? DEFAULT_WS_PORT);
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
const publicUrl = process.env.LIVEMCP_PUBLIC_URL ? new URL(process.env.LIVEMCP_PUBLIC_URL) : undefined;
if (publicUrl && (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password)) throw new Error('LIVEMCP_PUBLIC_URL must be an HTTPS origin, e.g. https://browser.example.com');
type Account = { id: string; agentToken: string; browserToken: string; router: BrowserRouter };
const config = process.env.LIVEMCP_ACCOUNTS;
const accounts: Account[] = config ? JSON.parse(config) : process.env.LIVEMCP_TOKEN ? [{ id: 'default', agentToken: process.env.LIVEMCP_TOKEN, browserToken: process.env.LIVEMCP_TOKEN }] : [];
if (!Array.isArray(accounts)) throw new Error('LIVEMCP_ACCOUNTS must be a JSON array');
const authenticated = accounts.length > 0;
if ((!loopback || publicUrl) && !authenticated) throw new Error('Hosted/network access requires LIVEMCP_TOKEN or LIVEMCP_ACCOUNTS');
const ids = new Set<string>(), tokens = new Map<string, string>();
for (const a of accounts) {
  if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw new Error('Account IDs must be unique nonempty strings');
  ids.add(a.id);
  for (const token of [a.agentToken, a.browserToken]) {
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('Access tokens must contain at least 32 non-whitespace characters');
    if (tokens.has(token) && tokens.get(token) !== a.id) throw new Error('Tokens cannot be shared between accounts');
    tokens.set(token, a.id);
  }
  a.router = new BrowserRouter();
}
const local: Account = { id: 'local', agentToken: '', browserToken: '', router: new BrowserRouter() };
const hash = (s: string) => createHash('sha256').update(s).digest();
function authenticate(value: unknown, role: 'agentToken' | 'browserToken'): Account | undefined {
  if (!authenticated) return local;
  if (typeof value !== 'string' || value.length > 4096) return;
  const digest = hash(value);
  return accounts.find(a => timingSafeEqual(hash(a[role]), digest));
}
function requestAllowed(req: IncomingMessage, browser = false) {
  const allowedHosts = new Set([publicUrl?.host, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${host.includes(':') ? `[${host}]` : host}:${port}`]);
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (browser && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  if (publicUrl && origin === publicUrl.origin) return true;
  return loopback && [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`].includes(origin);
}

type HttpSession = { owner: string; transport: StreamableHTTPServerTransport; bridge: Bridge; touched: number };
const httpSessions = new Map<string, HttpSession>();
const httpServer = createServer(async (req, res) => {
  const respond = (code: number, message: string) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
  if (!requestAllowed(req)) { respond(403, 'Host or Origin not allowed'); return; }
  if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  if (req.url !== '/mcp') { respond(404, 'Not found'); return; }
  const authorization = req.headers.authorization;
  const account = authenticate(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, 'agentToken');
  if (!account) { res.setHeader('WWW-Authenticate', 'Bearer realm="livemcp"'); respond(401, 'Valid bearer token required'); return; }
  if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) { res.setHeader('Allow', 'POST, GET, DELETE'); respond(405, 'Method not allowed'); return; }
  let fresh: HttpSession | undefined;
  try {
    const sessionId = req.headers['mcp-session-id'];
    let session = typeof sessionId === 'string' ? httpSessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.owner !== account.id)) { respond(404, 'Session not found'); return; }
    let body: unknown;
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.split(';')[0].trim().match(/^application\/json$/i)) { respond(415, 'Use application/json'); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { respond(413, 'Request too large'); return; } chunks.push(Buffer.from(chunk)); }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { respond(400, 'Invalid JSON'); return; }
    }
    if (!session) {
      if (sessionId || req.method !== 'POST' || !isInitializeRequest(body)) { respond(400, 'Initialize an MCP session first'); return; }
      if (httpSessions.size >= 1000 || [...httpSessions.values()].filter(s => s.owner === account.id).length >= 100) { respond(503, 'Session limit reached'); return; }
      const bridge = account.router.session();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, onsessioninitialized: id => { httpSessions.set(id, fresh!); } });
      session = fresh = { owner: account.id, transport, bridge, touched: Date.now() };
      const mcp = createMcpServer(bridge);
      await mcp.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => { if (transport.sessionId) httpSessions.delete(transport.sessionId); void bridge.close(); onclose?.(); };
    }
    session.touched = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    await session.transport.handleRequest(req, res, body);
    if (fresh && !fresh.transport.sessionId) { await fresh.transport.close(); await fresh.bridge.close(); }
  } catch {
    if (fresh) { await fresh.transport.close(); await fresh.bridge.close(); }
    if (!res.headersSent) respond(500, 'MCP request failed'); else res.end();
  }
});
httpServer.requestTimeout = 30000;
httpServer.headersTimeout = 15000;
const expiry = setInterval(() => { for (const s of httpSessions.values()) if (Date.now() - s.touched > 30 * 60 * 1000) void s.transport.close(); }, 60000);
expiry.unref();
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
httpServer.on('upgrade', (req, sock, head) => {
  const path = req.url?.split('?')[0];
  if (!requestAllowed(req, true) || (path !== '/browser' && (authenticated || path !== '/'))) { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  if (wss.clients.size >= 1000) { sock.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, sock, head, ws => {
    if (!authenticated) { local.router.attach(ws); return; }
    const timeout = setTimeout(() => ws.close(1008, 'Authentication timeout'), 5000);
    ws.on('error', () => {});
    ws.on('close', () => clearTimeout(timeout));
    ws.once('message', raw => {
      clearTimeout(timeout);
      let hello: any; try { hello = JSON.parse(raw.toString()); } catch {}
      const account = validHello(hello) ? authenticate(hello.token, 'browserToken') : undefined;
      if (!account) { ws.close(1008, 'Invalid browser access token or hello'); return; }
      account.router.attach(ws, hello); ws.send(JSON.stringify({ type: 'hello_ack' }));
    });
  });
});

// IPC remains available for local stdio clients. Never unlink another running hub's socket.
let ownsSocket = false;
const ipcServer = createNetServer(sock => {
  sock.setEncoding('utf8'); let buffer = '';
  const sessions = new Map<string, Bridge>();
  const active = new Set<string>();
  const send = (message: object) => { if (!sock.destroyed) sock.write(JSON.stringify(message) + '\n'); };
  sock.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { sock.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg.sessionId !== 'string') continue;
      if (msg.type === 'register') {
        const account = authenticate(msg.token, 'agentToken');
        if (!account || sessions.size >= 100) { sock.destroy(); return; }
        if (!sessions.has(msg.sessionId)) sessions.set(msg.sessionId, account.router.session(send, typeof msg.browserId === 'string' ? msg.browserId : undefined));
        send({ type: 'registered', sessionId: msg.sessionId }); continue;
      }
      const bridge = sessions.get(msg.sessionId); if (!bridge) continue;
      if (msg.type === 'unregister') { void bridge.close(); sessions.delete(msg.sessionId); continue; }
      const key = `${msg.sessionId}:${msg.id}`;
      if (msg.type === 'cancel') { active.delete(key); continue; }
      if (msg.type !== 'request' || typeof msg.id !== 'string' || active.has(key)) continue;
      active.add(key);
      const promise = msg.action === 'hub.listBrowsers' ? bridge.listBrowsers!() : msg.action === 'hub.selectBrowser' ? bridge.selectBrowser!(msg.params?.browserId) : bridge.request(msg.action, msg.params ?? {});
      void promise.then(result => { if (active.delete(key)) send({ type: 'response', id: msg.id, result }); }, error => { if (active.delete(key)) send({ type: 'response', id: msg.id, error: error.message }); });
    }
  });
  sock.on('close', () => { active.clear(); for (const bridge of sessions.values()) void bridge.close(); });
  sock.on('error', () => {});
});
ipcServer.on('error', error => { process.stderr.write(`[livemcp-hub] IPC: ${error.message}. Stop the existing hub or use another LIVEMCP_HUB_SOCK; remove stale sockets only after checking the hub is stopped.\n`); shutdown(1); });
if (process.env.LIVEMCP_DISABLE_IPC !== '1') ipcServer.listen(HUB_SOCK, () => { ownsSocket = true; chmodSync(HUB_SOCK, 0o600); });
httpServer.on('error', error => { process.stderr.write(`[livemcp-hub] ${error.message}\n`); shutdown(1); });
httpServer.listen(port, host, () => process.stderr.write(`[livemcp-hub] Ready — HTTP /mcp and WebSocket /browser on ${host}:${port}; ${authenticated ? 'authenticated' : 'local only'}\n`));
function shutdown(code = 0) {
  clearInterval(expiry); for (const s of httpSessions.values()) void s.transport.close();
  for (const a of [...accounts, local]) a.router.close();
  ipcServer.close(); wss.close(); httpServer.close();
  if (ownsSocket) { try { unlinkSync(HUB_SOCK); } catch {} }
  process.exit(code);
}
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
