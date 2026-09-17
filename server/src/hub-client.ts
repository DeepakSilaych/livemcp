import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { executionBudget, type BridgeAction } from '@livemcp/shared';
import type { Bridge } from './bridge.js';
export const HUB_SOCK = process.env.LIVEMCP_HUB_SOCK ?? '/tmp/livemcp-hub.sock';
type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
export function createHubClient(requestTimeoutMs = 0): Bridge {
  const sessionId = randomUUID(), pending = new Map<string, Pending>();
  let sock: Socket, hubConnected = false, extensionConnected = false, closed = false, attempt = 0;
  let selectedBrowserId: string | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const failPending = (message: string) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  };
  const send = (msg: object) => sock.write(JSON.stringify(msg) + '\n');
  function connect() {
    if (closed) return;
    const connection = createConnection(HUB_SOCK); connection.setEncoding('utf8'); sock = connection;
    let buf = '';
    connection.on('connect', () => { hubConnected = true; attempt = 0; send({ type: 'register', sessionId, browserId: selectedBrowserId, token: process.env.LIVEMCP_TOKEN }); });
    connection.on('data', chunk => {
      buf += chunk.toString();
      if (buf.length > 32 * 1024 * 1024) { connection.destroy(new Error('Hub response exceeded 32 MB')); return; }
      let end: number;
      while ((end = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, end); buf = buf.slice(end + 1);
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'status') {
          extensionConnected = Boolean(msg.connected);
          if (typeof msg.browserId === 'string') selectedBrowserId = msg.browserId;
        } else if (msg.type === 'response') {
          const slot = pending.get(msg.id); if (!slot) continue;
          clearTimeout(slot.timer); pending.delete(msg.id);
          msg.error !== undefined ? slot.reject(new Error(String(msg.error))) : slot.resolve(msg.result);
        }
      }
    });
    connection.on('close', () => {
      hubConnected = false; extensionConnected = false;
      failPending('Hub disconnected; action outcome may be unknown.');
      if (!closed) { reconnect = setTimeout(connect, Math.min(5000, 250 * 2 ** attempt++)); reconnect.unref(); }
    });
    connection.on('error', error => { if (attempt === 0) process.stderr.write(`[livemcp] ${error.message}; reconnecting without replaying actions.\n`); });
  }
  connect();
  const request = (action: BridgeAction | 'hub.listBrowsers' | 'hub.selectBrowser', params: Record<string, unknown> = {}) => {
    if (!hubConnected || (!extensionConnected && !action.startsWith('hub.'))) return Promise.reject(new Error(!hubConnected ? 'Hub unavailable; start livemcp-hub. Connection will recover automatically.' : 'Chrome extension not connected to hub'));
    if (pending.size >= 100) return Promise.reject(new Error('Too many outstanding browser requests.'));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); send({ type: 'cancel', sessionId, id }); reject(new Error('BRIDGE_TIMEOUT: Bridge request timed out; inspect tab health and state before retrying.')); }, requestTimeoutMs || executionBudget(action, params) + 3000);
      pending.set(id, { resolve, reject, timer }); send({ type: 'request', sessionId, id, action, params });
    });
  };
  const close = async () => { closed = true; clearTimeout(reconnect); if (hubConnected) send({ type: 'unregister', sessionId }); failPending('Bridge closed'); sock.destroy(); };
  return { request, close, listBrowsers: () => request('hub.listBrowsers', {}), selectBrowser: browserId => request('hub.selectBrowser', { browserId }), isConnected: () => hubConnected && extensionConnected };
}
