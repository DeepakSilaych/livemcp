import { test, expect } from '@playwright/test';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

test('hub fails pending calls immediately when extension disconnects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'livemcp-test-')), socketPath = join(dir, 'hub.sock');
  const portFinder = createServer(); portFinder.listen(0, '127.0.0.1'); await once(portFinder, 'listening'); const port = (portFinder.address() as any).port; await new Promise<void>(r => portFinder.close(() => r()));
  const hub = spawn(process.execPath, ['server/dist/hub.js'], { env: { ...process.env, LIVEMCP_HUB_SOCK: socketPath, LIVEMCP_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; hub.stderr.on('data', b => logs += String(b));
  let ws: WebSocket | undefined, client: ReturnType<typeof createConnection> | undefined;
  try {
    await expect.poll(() => logs).toContain('Ready');
    ws = new WebSocket(`ws://127.0.0.1:${port}`); await once(ws, 'open');
    client = createConnection(socketPath); await once(client, 'connect');
    const lines: any[] = []; let buffer = '';
    client.on('data', b => { buffer += String(b); let end; while ((end = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    client.write(JSON.stringify({ type: 'register', sessionId: 'test' }) + '\n'); await expect.poll(() => lines.some(l => l.type === 'registered')).toBe(true);
    const forwarded = once(ws, 'message'); client.write(JSON.stringify({ type: 'request', sessionId: 'test', id: 'pending', action: 'tabs.list' }) + '\n'); await forwarded;
    ws.close(); await expect.poll(() => lines.find(l => l.id === 'pending')?.error).toContain('disconnected');
  } finally { ws?.terminate(); client?.destroy(); hub.kill(); await once(hub, 'exit'); await rm(dir, { recursive: true, force: true }); }
});

test('session reconnects after a hub restart without replaying an uncertain action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'livemcp-reconnect-')), path = join(dir, 'hub.sock');
  const previous = process.env.LIVEMCP_HUB_SOCK; process.env.LIVEMCP_HUB_SOCK = path;
  const { createHubClient } = await import('../server/src/hub-client');
  const sockets = new Set<any>(); let requests = 0;
  const listen = async (reply: boolean) => {
    const server = createServer(sock => {
      sockets.add(sock); sock.setEncoding('utf8'); let buffer = '';
      sock.on('close', () => sockets.delete(sock));
      sock.on('data', chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (msg.type === 'register') sock.write(JSON.stringify({ type: 'status', connected: true }) + '\n');
          if (msg.type === 'request') { requests++; if (reply) sock.write(JSON.stringify({ type: 'response', id: msg.id, result: { title: 'हैलो' } }) + '\n'); }
        }
      });
    }); server.listen(path); await once(server, 'listening'); return server;
  };
  let server = await listen(false); const client = createHubClient();
  try {
    await expect.poll(client.isConnected).toBe(true);
    const pending = client.request('tabs.list').catch(e => e.message); await expect.poll(() => requests).toBe(1);
    for (const sock of sockets) sock.destroy(); await new Promise<void>(r => server.close(() => r()));
    expect(await pending).toContain('disconnected');
    server = await listen(true); await expect.poll(client.isConnected).toBe(true);
    expect(requests).toBe(1); expect(await client.request('tabs.list')).toEqual({ title: 'हैलो' }); expect(requests).toBe(2);
  } finally { await client.close(); for (const sock of sockets) sock.destroy(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.LIVEMCP_HUB_SOCK; else process.env.LIVEMCP_HUB_SOCK = previous; }
});

test('multiple browsers route independently and never fall back after disconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'livemcp-multi-')), socketPath = join(dir, 'hub.sock');
  const finder = createServer(); finder.listen(0,'127.0.0.1'); await once(finder,'listening'); const port = (finder.address() as any).port; await new Promise<void>(r => finder.close(() => r()));
  const hub = spawn(process.execPath, ['server/dist/hub.js'], { env: { ...process.env, LIVEMCP_HUB_SOCK: socketPath, LIVEMCP_PORT: String(port) }, stdio: ['ignore','ignore','pipe'] });
  let logs = ''; hub.stderr.on('data', b => logs += String(b));
  const websockets: WebSocket[] = [], clients: any[] = [];
  try {
    await expect.poll(() => logs).toContain('Ready');
    const browser = async (id: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`); websockets.push(ws); await once(ws,'open');
      ws.send(JSON.stringify({ type: 'hello', browserId: id, name: id }));
      ws.on('message', raw => { const msg = JSON.parse(String(raw)); if (msg.action === 'tabs.list') ws.send(JSON.stringify({ id: msg.id, result: [{ id: 1, title: id }] })); });
      return ws;
    };
    const a = await browser('browser-A'), b = await browser('browser-B');
    const session = async (sessionId: string) => {
      const sock = createConnection(socketPath); clients.push(sock); await once(sock,'connect'); sock.setEncoding('utf8');
      let buffer = '', count = 0; const waiting = new Map<string, (msg: any) => void>();
      sock.on('data', (chunk: string) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const msg = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
      sock.write(JSON.stringify({ type: 'register', sessionId })+'\n');
      return (action: string, params: any = {}) => new Promise<any>((resolve,reject) => {
        const id = String(++count), timer = setTimeout(() => { waiting.delete(id); reject(new Error('Request timeout')); },3000);
        waiting.set(id, msg => { clearTimeout(timer); resolve(msg); }); sock.write(JSON.stringify({ type: 'request', sessionId, id, action, params })+'\n');
      });
    };
    const one = await session('one'), two = await session('two');
    await expect.poll(async () => (await one('hub.listBrowsers')).result.browsers.filter((x: any) => !x.legacy).length).toBe(2);
    expect((await one('tabs.list')).error).toContain('Multiple browsers');
    await one('hub.selectBrowser',{ browserId: 'browser-A' }); await two('hub.selectBrowser',{ browserId: 'browser-B' });
    const [r1,r2] = await Promise.all([one('tabs.list'),two('tabs.list')]);
    expect(r1.result[0].title).toBe('browser-A'); expect(r2.result[0].title).toBe('browser-B');
    expect(b.readyState).toBe(WebSocket.OPEN);
    const fromA = once(a, 'message'), fromB = once(b, 'message');
    const pendingA = one('content.getPage'), pendingB = two('content.getPage');
    const wireA = JSON.parse(String((await fromA)[0])), wireB = JSON.parse(String((await fromB)[0]));
    expect(wireA.id).not.toBe(wireB.id);
    a.send(JSON.stringify({ id: wireB.id, result: 'wrong browser' }));
    a.close(); await once(a,'close');
    expect((await pendingA).error).toContain('disconnected');
    b.send(JSON.stringify({ id: wireB.id, result: 'correct browser' }));
    expect((await pendingB).result).toBe('correct browser');
    await expect.poll(async () => (await one('tabs.list')).error).toContain('Selected browser disconnected');
    expect((await two('tabs.list')).result[0].title).toBe('browser-B');
    await browser('browser-A');
    await expect.poll(async () => (await one('tabs.list')).result?.[0]?.title).toBe('browser-A');
  } finally { for (const ws of websockets) ws.terminate(); for (const sock of clients) sock.destroy(); hub.kill(); await once(hub,'exit'); await rm(dir,{ recursive:true,force:true }); }
});
