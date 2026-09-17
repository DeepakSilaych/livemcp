import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { BRIDGE_ACTIONS, isBridgeResponse, executionBudget } from '@livemcp/shared';
import type { Bridge } from './bridge.js';

type Browser = { id: string; name: string; ws: WebSocket; connectedAt: string; legacy: boolean };
type Session = { browserId?: string; notify: (message: object) => void };
type Pending = { session: Session; browser: Browser; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One router per account: browser IDs and selections never cross account boundaries. */
export class BrowserRouter {
  private browsers = new Map<string, Browser>();
  private sessions = new Set<Session>();
  private pending = new Map<string, Pending>();

  list() { return [...this.browsers.values()].filter(b => b.ws.readyState === WebSocket.OPEN).map(({ id, name, connectedAt, legacy }) => ({ id, name, connectedAt, legacy })); }
  private status(s: Session) { s.notify({ type: 'status', connected: this.list().length > 0, browserId: s.browserId }); }
  private broadcast() { for (const s of this.sessions) this.status(s); }
  private finish(id: string, error?: string, result?: unknown) {
    const p = this.pending.get(id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id);
    error !== undefined ? p.reject(new Error(error)) : p.resolve(result);
  }
  private remove(browser: Browser) {
    if (this.browsers.get(browser.id) !== browser) return;
    this.browsers.delete(browser.id);
    for (const [id,p] of this.pending) if (p.browser === browser) this.finish(id, 'Browser disconnected; action outcome may be unknown.');
    this.broadcast();
  }
  attach(ws: WebSocket, hello?: { browserId: string; name?: string }) {
    const browser: Browser = { id: hello?.browserId ?? `legacy-${randomUUID()}`, name: hello?.name?.slice(0,80) || 'Browser (legacy extension)', ws, connectedAt: new Date().toISOString(), legacy: !hello };
    const replace = () => {
      const previous = this.browsers.get(browser.id);
      if (previous) { this.remove(previous); previous.ws.close(1000, 'Browser reconnected'); }
      this.browsers.set(browser.id, browser); this.broadcast();
    };
    replace();
    let alive = true;
    const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 25000);
    ws.on('pong', () => { alive = true; });
    ws.on('message', raw => {
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'hello') {
        if (!validHello(msg) || (!browser.legacy && browser.id !== msg.browserId)) { ws.close(1008, 'Invalid browser identity'); return; }
        if (browser.id !== msg.browserId) {
          this.browsers.delete(browser.id);
          for (const s of this.sessions) if (s.browserId === browser.id) s.browserId = msg.browserId;
          browser.id = msg.browserId;
          replace();
        }
        browser.name = msg.name?.slice(0,80) || 'Chrome'; browser.legacy = false; this.broadcast();
        ws.send(JSON.stringify({ type: 'hello_ack' })); return;
      }
      if (!isBridgeResponse(msg)) return;
      const p = this.pending.get(msg.id);
      if (p?.browser === browser && this.browsers.get(browser.id) === browser) this.finish(msg.id, msg.error, msg.result);
    });
    const cleanup = () => { clearInterval(ping); this.remove(browser); };
    ws.on('close', cleanup); ws.on('error', cleanup);
  }
  session(notify: (message: object) => void = () => {}, browserId?: string): Bridge {
    const s: Session = { notify, browserId }; this.sessions.add(s); this.status(s);
    let closed = false;
    return {
      isConnected: () => !closed && this.list().length > 0,
      listBrowsers: async () => ({ browsers: this.list(), selectedBrowserId: s.browserId ?? null }),
      selectBrowser: async id => {
        if (closed || !this.browsers.has(id)) throw new Error('Browser unavailable. Call list_browsers for connected browsers.');
        s.browserId = id; this.status(s); return { browserId: id, name: this.browsers.get(id)!.name };
      },
      request: async (action, params) => {
        if (closed) throw new Error('Session closed');
        if (!(BRIDGE_ACTIONS as readonly string[]).includes(action)) throw new Error('Unknown browser action');
        if (!s.browserId) {
          const list = this.list();
          if (list.length !== 1) throw new Error(list.length ? 'Multiple browsers connected. Call list_browsers then select_browser before using tabs.' : 'Chrome extension not connected to hub');
          s.browserId = list[0].id; this.status(s);
        }
        const browser = this.browsers.get(s.browserId);
        if (!browser || browser.ws.readyState !== WebSocket.OPEN) throw new Error('Selected browser disconnected. Reconnect it or explicitly select_browser; no fallback to another browser.');
        if (this.pending.size >= 1000 || [...this.pending.values()].filter(p => p.session === s).length >= 100) throw new Error('Hub busy; retry later.');
        return new Promise((resolve, reject) => {
          const id = randomUUID(), budget = executionBudget(action, params);
          this.pending.set(id, { session: s, browser, resolve, reject, timer: setTimeout(() => this.finish(id, 'BRIDGE_TIMEOUT: Bridge deadline exceeded; inspect tab health and state before retrying.'), budget + 1000) });
          browser.ws.send(JSON.stringify({ id, action, params: { ...params, __deadline: Date.now() + budget } }), err => { if (err) this.finish(id, 'Browser send failed; action outcome may be unknown.'); });
        });
      },
      close: async () => {
        closed = true; this.sessions.delete(s);
        for (const [id,p] of this.pending) if (p.session === s) this.finish(id, 'Session closed; action outcome may be unknown.');
      },
    };
  }
  close() { for (const b of this.browsers.values()) b.ws.terminate(); for (const id of this.pending.keys()) this.finish(id, 'Hub shutting down'); }
}
export function validHello(msg: any): msg is { type: 'hello'; browserId: string; name?: string; token?: string } {
  return msg?.type === 'hello' && typeof msg.browserId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(msg.browserId) && (msg.name === undefined || typeof msg.name === 'string');
}
