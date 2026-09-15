import { test, expect } from '@playwright/test';
import { startNetwork, getNetwork, stopNetwork, getBody, startConsole, getConsole } from '../extension/src/debuggerSession';
test('capture is bounded, bodies are lazy, and records survive stopping', async () => {
  const listeners = new Set<Function>(), detached = new Set<Function>(), commands: string[] = [];
  (globalThis as any).chrome = { runtime: {}, tabs: { onRemoved: { addListener() {} } }, debugger: {
    onEvent: { addListener: (f: Function) => listeners.add(f) }, onDetach: { addListener: (f: Function) => detached.add(f) },
    attach: (_target: any, _version: any, cb: Function) => cb(),
    detach: (target: any, cb: Function) => { for (const f of detached) f(target); cb(); },
    sendCommand: (_target: any, name: string, _args: any, cb: Function) => { commands.push(name); cb(name === 'Network.getResponseBody' ? { body: 'x'.repeat(1000), base64Encoded: false } : {}); },
  } };
  await startNetwork(123);
  const fire = (method: string, params: any) => { for (const f of listeners) f({ tabId: 123 }, method, params); };
  for (let i = 0; i < 510; i++) { fire('Network.requestWillBeSent', { requestId: String(i), request: { url: 'https://test/' + i, method: 'GET' } }); fire('Network.loadingFinished', { requestId: String(i) }); }
  const result: any = getNetwork(123, false, { limit: 10 }); expect(result.total).toBe(500); expect(result.dropped).toBe(10); expect(result.requests).toHaveLength(10);
  expect(commands).not.toContain('Network.getResponseBody'); const body: any = await getBody(123, '509', 100); expect(body.body).toHaveLength(100); expect(body.truncated).toBe(true);
  await stopNetwork(123); expect((getNetwork(123, false) as any).total).toBe(500);
  await startConsole(123);
  for (let i = 0; i < 510; i++) fire('Log.entryAdded', { entry: { text: 'x'.repeat(5000), level: 'error' } });
  const logs: any = getConsole(123, true); expect(logs.dropped).toBe(10); expect(logs.logs).toHaveLength(6); expect(logs.truncated).toBe(true); expect((getConsole(123, false) as any).total).toBe(494);
});
