import { test, expect, chromium } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { once } from 'node:events';

for (const authenticated of [false, true]) test(`built extension (${authenticated ? 'token' : 'local'}): real Chrome transport, refs, batch, iframe, images and errors`, async () => {
  test.setTimeout(30000);
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/browser' }); await once(wss, 'listening');
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
    let hello: any; let requestUrl: string | undefined;
    wss.on('connection', (ws, req) => { requestUrl = req.url; ws.once('message', raw => { hello = JSON.parse(String(raw)); if (authenticated) ws.send(JSON.stringify({ type: 'hello_ack' })); }); });
    const connected = once(wss, 'connection');
    context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(worker.url().replace('/dist/background.js', '/popup/popup.html'));
    await expect(popup.locator('#url')).toHaveValue('');
    await popup.locator('#url').fill(`ws://127.0.0.1:${port}/browser?test=1`);
    await popup.locator('#browserName').fill('Integration Chrome');
    if (authenticated) await popup.locator('#accessToken').fill('test-browser-token');
    await popup.locator('#connect').click();
    const [ws] = await connected as [WebSocket];
    await expect.poll(() => hello?.name).toBe('Integration Chrome');
    expect(hello.token).toBe(authenticated ? 'test-browser-token' : undefined);
    expect(hello.browserId).toBeTruthy(); expect(requestUrl).toBe('/browser?test=1');
    await expect(popup.locator('#status')).toHaveText('Connected');
    await popup.locator('#url').fill('not a URL');
    await worker.evaluate(async () => { await (globalThis as any).chrome.storage.local.set({ toolLog: [] }); });
    await expect(popup.locator('#url')).toHaveValue('not a URL');
    await popup.locator('#connect').click();
    await expect(popup.locator('#urlError')).not.toBeEmpty();
    expect(await worker.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('wsUrl')).wsUrl)).toBe(`ws://127.0.0.1:${port}/browser?test=1`);
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
    const missing = await call('interact.click', { tabId: tab.id, selector: '#missing' }); expect(missing.error).toContain('NOT_FOUND'); expect(missing.actionMayHaveOccurred).toBe(false);
    const frames = await call('browser.frames', { tabId: tab.id }); const frame = frames.frames.find((f: any) => f.url.endsWith('/frame'));
    expect(frame).toBeTruthy(); expect(JSON.stringify(await call('page.snapshot', { tabId: tab.id, frameId: frame.frameId }))).toContain('Frame button');
    // A separate active tab must not steal screenshot/input targeting.
    const otherPage = await context.newPage(); await otherPage.goto(url + '/other');
    const activeBefore = await call('tabs.getActive');
    const backgroundShot = await call('screenshot.capture', { tabId: tab.id });
    expect(backgroundShot.method).toBe('cdp'); expect((await call('tabs.getActive')).id).toBe(activeBefore.id);
    const otherTab = (await call('tabs.list')).find((t:any)=>t.url === url + '/other');
    const parallelShots = await Promise.all([call('screenshot.capture',{tabId:tab.id}),call('screenshot.capture',{tabId:otherTab.id})]);
    expect(parallelShots[0].dataUrl).not.toBe(parallelShots[1].dataUrl);
    await page.evaluate(() => {
      document.body.innerHTML = `<button id="trusted" onclick="this.dataset.trusted=String(event.isTrusted)">Trusted</button><input id="keys"><input id="readonly" readonly><div id="pop" style="height:60px;overflow:auto"><div style="height:300px"></div><div role="option" onclick="this.dataset.selected='yes'">FAK</div></div><div id="ready">Loading</div>`;
      document.querySelector('#readonly')!.addEventListener('keydown', (event: any) => { if(event.isTrusted) (event.target as HTMLElement).dataset.lastKey=event.key; });
    });
    await call('interact.click', { tabId: tab.id, selector:'#trusted', observe:false });
    expect(await page.locator('#trusted').getAttribute('data-trusted')).toBe('true');
    await call('interact.type', { tabId: tab.id, selector:'#keys', text:'typed by CDP', mode:'trusted', observe:false });
    expect(await page.locator('#keys').inputValue()).toBe('typed by CDP');
    await call('interact.pressKey', { tabId:tab.id,selector:'#readonly',key:'ArrowDown',observe:false });
    expect(await page.locator('#readonly').getAttribute('data-last-key')).toBe('ArrowDown');
    await call('interact.type', { tabId:tab.id,selector:'#readonly',text:'X',allowReadonly:true,observe:false });
    expect(await page.locator('#readonly').getAttribute('data-last-key')).toBe('X');
    await call('interact.selectOption', { tabId:tab.id,selector:'#pop',text:'FAK',observe:false });
    expect(await page.locator('[role=option]').getAttribute('data-selected')).toBe('yes');
    await page.evaluate(()=>setTimeout(()=>{document.querySelector('#ready')!.textContent='Rates ready';history.pushState({},'', '/rates');},150));
    expect((await call('browser.wait',{tabId:tab.id,kind:'text',text:'Rates ready',timeout:60000})).ready).toBe(true);
    expect((await call('browser.wait',{tabId:tab.id,kind:'url',url:'/rates',timeout:60000})).ready).toBe(true);
    expect((await call('browser.wait',{tabId:tab.id,kind:'networkIdle',quietMs:100,timeout:1000})).ready).toBe(true);
    expect((await call('browser.health',{tabId:tab.id})).responsive).toBe(true);
    expect((await call('content.readState',{tabId:tab.id,selector:'#keys'})).value).toBe('typed by CDP');
    expect((await call('tabs.getActive')).id).toBe(activeBefore.id);
    const pendingWait = call('browser.wait',{tabId:tab.id,kind:'text',text:'never arrives',timeout:800});
    await expect.poll(async()=>(await call('browser.health',{tabId:tab.id})).busy).toBe(true);
    expect((await call('browser.health',{tabId:tab.id,recoverDebugger:true})).error).toContain('TAB_BUSY');
    expect((await pendingWait).code).toBe('WAIT_TIMEOUT');
    expect((await call('browser.health',{tabId:tab.id,recoverDebugger:true})).debugger.attached).toBe(true);
    await otherPage.close();
    await call('tabs.switch', { tabId: tab.id });
    const screenshot = await call('screenshot.capture', { tabId: tab.id }); expect(screenshot.dataUrl).toMatch(/^data:image\/png;base64,/);
    const wait = await call('navigate.andWait', { tabId: tab.id, url: url + '/next', waitUntil: 'domcontentloaded', waitFor: '#go' }); expect(wait.error).toBeUndefined();
    expect((await call('interact.click', { tabId: tab.id, selector: goRef })).error).toContain('STALE_REF');
    if (authenticated) {
      ws.close(1008, 'Invalid browser access token');
      await expect(popup.locator('#status')).toContainText('Invalid browser access token');
      expect(await worker.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('bridgeUserWantsConnect')).bridgeUserWantsConnect)).toBe(false);
    }
  } finally { await context?.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => http.close(() => r())); }
});
