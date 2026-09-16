import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const accounts = [
  { id: 'alice', agentToken: 'a'.repeat(40), browserToken: 'b'.repeat(40) },
  { id: 'bob', agentToken: 'c'.repeat(40), browserToken: 'd'.repeat(40) },
];

test('hosted MCP authenticates, isolates owners, routes tools and closes sessions', async () => {
  const finder = createServer().listen(0, '127.0.0.1'); await once(finder, 'listening');
  const port = (finder.address() as any).port; await new Promise<void>(r => finder.close(() => r()));
  const hub = spawn(process.execPath, ['server/dist/hub.js'], { env: { ...process.env, LIVEMCP_PORT: String(port), LIVEMCP_HOST: '127.0.0.1', LIVEMCP_DISABLE_IPC: '1', LIVEMCP_ACCOUNTS: JSON.stringify(accounts) }, stdio: ['ignore','ignore','pipe'] });
  let logs = ''; hub.stderr.on('data', b => logs += b);
  const browsers: WebSocket[] = [], clients: Client[] = [];
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  async function client(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const c = new Client({ name: 'test', version: '1' }); clients.push(c); await c.connect(transport); return { c, transport };
  }
  async function browser(token: string, name: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser`); browsers.push(ws); await once(ws,'open');
    const ack = once(ws,'message'); ws.send(JSON.stringify({ type: 'hello', browserId: 'same-profile-id', name, token }));
    expect(JSON.parse(String((await ack)[0])).type).toBe('hello_ack');
    ws.on('message', raw => { const req = JSON.parse(String(raw)); if (req.id) ws.send(JSON.stringify({ id: req.id, result: [{ id: name === 'Alice' ? 1 : 2, title: name }] })); });
    return ws;
  }
  const content = (result: any) => JSON.parse(result.content[0].text);
  try {
    await expect.poll(() => logs).toContain('Ready');
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${accounts[0].browserToken}` } })).status).toBe(401);
    expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${accounts[0].agentToken}`, Origin: 'https://evil.example' } })).status).toBe(403);
    const bad = new WebSocket(`ws://127.0.0.1:${port}/browser`); browsers.push(bad); await once(bad,'open');
    const close = once(bad,'close'); bad.send(JSON.stringify({ type: 'hello', browserId: 'invalid-profile', token: accounts[0].agentToken })); expect((await close)[0]).toBe(1008);
    const alice = await client(accounts[0].agentToken), bob = await client(accounts[1].agentToken);
    expect(content(await alice.c.callTool({ name:'list_browsers', arguments: {} })).browsers).toHaveLength(0);
    await browser(accounts[0].browserToken, 'Alice'); await browser(accounts[1].browserToken, 'Bob');
    expect(content(await alice.c.callTool({ name:'list_browsers', arguments: {} })).browsers.map((b: any) => b.name)).toEqual(['Alice']);
    expect(content(await bob.c.callTool({ name:'list_browsers', arguments: {} })).browsers.map((b: any) => b.name)).toEqual(['Bob']);
    expect((await alice.c.listTools()).tools.some(t => t.name === 'list_tabs')).toBe(true);
    expect(JSON.stringify(await alice.c.callTool({ name: 'list_tabs', arguments: {} }))).toContain('Alice');
    expect(JSON.stringify(await bob.c.callTool({ name: 'list_tabs', arguments: {} }))).toContain('Bob');
    expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${accounts[1].agentToken}`, 'Mcp-Session-Id': alice.transport.sessionId! } })).status).toBe(404);
    const id = alice.transport.sessionId!; await alice.transport.terminateSession();
    expect((await fetch(endpoint, { headers: { Authorization: `Bearer ${accounts[0].agentToken}`, 'Mcp-Session-Id': id } })).status).toBe(404);
    expect(logs).not.toContain(accounts[0].agentToken);
  } finally {
    for (const c of clients) await c.close(); for (const ws of browsers) ws.terminate();
    hub.kill(); await once(hub,'exit');
  }
});

test('hub refuses unauthenticated network binding', async () => {
  const hub = spawn(process.execPath, ['server/dist/hub.js'], { env: { ...process.env, LIVEMCP_HOST: '0.0.0.0', LIVEMCP_DISABLE_IPC: '1', LIVEMCP_TOKEN: '', LIVEMCP_ACCOUNTS: '' }, stdio: ['ignore','ignore','pipe'] });
  let logs = ''; hub.stderr.on('data', b => logs += b);
  expect((await once(hub,'exit'))[0]).not.toBe(0); expect(logs).toContain('requires LIVEMCP_TOKEN');
});

for (const auth of [false, true]) test(`local stdio and HTTP share one hub (token=${auth})`, async () => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'livemcp-local-'));
  const finder = createServer().listen(0, '127.0.0.1'); await once(finder, 'listening');
  const port = (finder.address() as any).port; await new Promise<void>(r => finder.close(() => r()));
  const token = auth ? 'local-test-token-'.repeat(4) : '';
  const env = { ...process.env, LIVEMCP_HOST: '127.0.0.1', LIVEMCP_PORT: String(port), LIVEMCP_HUB_SOCK: join(dir,'hub.sock'), LIVEMCP_DISABLE_IPC: '', LIVEMCP_ACCOUNTS: '', LIVEMCP_PUBLIC_URL: '', LIVEMCP_TOKEN: token };
  const hub = spawn(process.execPath, ['server/dist/hub.js'], { env, stdio: ['ignore','ignore','pipe'] });
  let logs = ''; hub.stderr.on('data', b => logs += b);
  let ws: WebSocket | undefined;
  const stdio = new Client({ name: 'stdio-test', version: '1' });
  const http = new Client({ name: 'http-test', version: '1' });
  try {
    await expect.poll(() => logs).toContain('Ready');
    ws = new WebSocket(`ws://127.0.0.1:${port}/browser`); await once(ws,'open');
    const ack = once(ws,'message'); ws.send(JSON.stringify({ type: 'hello', browserId: 'local-profile', name: 'Local profile', token })); await ack;
    ws.on('message', raw => { const req = JSON.parse(String(raw)); if (req.id) ws!.send(JSON.stringify({ id: req.id, result: [{ id: 123, title: 'Shared local browser' }] })); });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['server/dist/index.js'], env: Object.fromEntries(Object.entries(env).filter((e): e is [string,string] => typeof e[1] === 'string')) }));
    await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
    await expect.poll(async () => JSON.stringify(await stdio.callTool({ name:'list_tabs', arguments: {} }))).toContain('Shared local browser');
    expect(JSON.stringify(await http.callTool({ name:'list_tabs', arguments: {} }))).toContain('Shared local browser');
  } finally {
    await stdio.close(); await http.close(); ws?.terminate(); hub.kill(); await once(hub,'exit'); await rm(dir, { recursive:true, force:true });
  }
});
