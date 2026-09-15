import { test, expect, chromium } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { once } from 'node:events';

test('built extension: real Chrome transport, refs, batch, iframe, images and errors', async () => {
  test.setTimeout(30000);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(wss, 'listening');
  const port = (wss.address() as any).port;
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') res.end('<button id="inner">Frame button</button>');
    else res.end('<title>Fixture</title><input id="input"><button id="go" onclick="document.querySelector(\'#result\').textContent=\'Done\'">Go</button><p id="result">Waiting</p><iframe src="/frame"></iframe>');
  }); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const extension = resolve('extension');
  let context: any;
  try {
    const connected = once(wss, 'connection');
    context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(async (port: number) => { await (globalThis as any).chrome.storage.local.set({ bridgeUserWantsConnect: true, wsPort: port }); }, port);
    const [ws] = await connected as [WebSocket];
    const call = (action: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('test call timeout')); }, 8000);
      function listener(raw: any) { const msg = JSON.parse(String(raw)); if (msg.id !== id) return; clearTimeout(timer); ws.off('message', listener); msg.error ? reject(new Error(msg.error)) : resolve(msg.result); }
      ws.on('message', listener); ws.send(JSON.stringify({ id, action, params }));
    });
    const page = await context.newPage(); await page.goto(url);
    const tabs = await call('tabs.list'); const tab = tabs.find((t: any) => t.url === url + '/'); expect(tab).toBeTruthy();
    const snapshot = await call('page.snapshot', { tabId: tab.id });
    expect(snapshot.screenshot).toBeUndefined(); expect(snapshot.nodes.some((n: any) => n.text.includes('Go'))).toBe(true);
    const inputRef = snapshot.nodes.find((n: any) => n.text.startsWith('textbox')).ref;
    const goRef = snapshot.nodes.find((n: any) => n.text.includes('"Go"')).ref;
    const batch = await call('browser.batch', { tabId: tab.id, steps: [{ action: 'type', selector: inputRef, text: 'typed', clear: true }, { action: 'click', selector: goRef }] });
    expect(batch.completed).toBe(2); expect(JSON.stringify(batch.observation)).toContain('Done'); expect(await page.locator('#input').inputValue()).toBe('typed');
    await expect(call('interact.click', { tabId: tab.id, selector: '#missing' })).rejects.toThrow('NOT_FOUND');
    const frames = await call('browser.frames', { tabId: tab.id }); const frame = frames.frames.find((f: any) => f.url.endsWith('/frame'));
    expect(frame).toBeTruthy(); expect(JSON.stringify(await call('page.snapshot', { tabId: tab.id, frameId: frame.frameId }))).toContain('Frame button');
    await call('tabs.switch', { tabId: tab.id });
    const screenshot = await call('screenshot.capture', { tabId: tab.id }); expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,/);
    const wait = await call('navigate.andWait', { tabId: tab.id, url: url + '/next', waitUntil: 'domcontentloaded', waitFor: '#go' }); expect(wait.error).toBeUndefined();
    await expect(call('interact.click', { tabId: tab.id, selector: goRef })).rejects.toThrow('STALE_REF');
  } finally { await context?.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => http.close(() => r())); }
});
