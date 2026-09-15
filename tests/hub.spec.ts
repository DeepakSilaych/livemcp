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
