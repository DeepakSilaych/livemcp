import { test, expect } from '@playwright/test';
import { imageResult } from '../server/src/toolResult';
import { navigateAndWait } from '../extension/src/handlers/navigate';
import { clickAndWait } from '../extension/src/handlers/interact';
import { resolveTabSpec } from '../extension/src/chromeApi';
import { capture } from '../extension/src/handlers/screenshot';
import { runBatch } from '../extension/src/handlers/batch';
function event() {
  const listeners = new Set<Function>();
  return { listeners, addListener: (f: Function) => listeners.add(f), removeListener: (f: Function) => listeners.delete(f), fire: (...args: any[]) => { for (const f of [...listeners]) f(...args); } };
}
function mockChrome() {
  const onUpdated = event(), onRemoved = event();
  const chrome = {
    runtime: { lastError: undefined },
    tabs: { onUpdated, onRemoved,
      query: (_q: any, cb: any) => cb([{ id: 1, windowId: 1, url: 'https://one.test', active: true }]),
      get: (id: number, cb: any) => cb({ id, windowId: 1, url: 'https://one.test', active: id === 1 }),
      update: (id: number, props: any, cb: any) => { onUpdated.fire(id, { status: 'loading' }); onUpdated.fire(id, { url: props.url, status: 'complete' }); cb({ id, url: props.url }); },
      captureVisibleTab: (_id: any, _options: any, cb: any) => cb('data:image/png;base64,YWJj'),
    },
    scripting: { executeScript: (_options: any, cb: any) => cb([{ result: { performed: true } }]) },
  };
  (globalThis as any).chrome = chrome; return chrome;
}
test('screenshots are image blocks, never base64 text', () => {
  const result = imageResult({ tabId: 1, dataUrl: 'data:image/png;base64,YWJj' });
  expect(result.content[0].type).toBe('image'); expect(JSON.stringify(result.content.slice(1))).not.toContain('YWJj');
  expect(imageResult({ dataUrl: 'bad' }).isError).toBe(true);
});
test('navigation listener catches completion during action callback', async () => {
  const chrome = mockChrome();
  const result: any = await navigateAndWait({ tabId: 1, url: 'https://new.test', observe: false, timeout: 200 });
  expect(result.navigated).toBe(true); expect(result.error).toBeUndefined(); expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
});
test('click navigation listener is installed before script runs', async () => {
  const chrome = mockChrome();
  chrome.scripting.executeScript = (_options, cb) => { chrome.tabs.onUpdated.fire(1, { status: 'loading' }); chrome.tabs.onUpdated.fire(1, { status: 'complete' }); cb([{ result: { performed: true } }]); };
  const result = await clickAndWait({ tabId: 1, selector: '#go', waitForNavigation: true, observe: false, timeout: 200 });
  expect(result.error).toBeUndefined(); expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
});
test('click timeout preserves uncertain outcome and cleans listeners', async () => {
  const chrome = mockChrome();
  const result = await clickAndWait({ tabId: 1, selector: '#go', waitForNavigation: true, observe: false, timeout: 20 });
  expect(result.error).toContain('NAVIGATION_TIMEOUT'); expect(result.actionMayHaveOccurred).toBe(true); expect(chrome.tabs.onUpdated.listeners.size).toBe(0);
});
test('ambiguous tab discovery fails and exact ID bypasses discovery', async () => {
  const chrome = mockChrome(); chrome.tabs.query = (_q, cb) => cb([{ id: 1, url: 'https://same.test/a' }, { id: 2, url: 'https://same.test/b' }]);
  await expect(resolveTabSpec({ tabUrl: 'same.test' })).rejects.toThrow('Ambiguous');
  expect(await resolveTabSpec({ tabId: 2 })).toBe(2);
});
test('background screenshot is rejected instead of capturing wrong tab', async () => {
  mockChrome(); await expect(capture({ tabId: 2 })).rejects.toThrow('SCREENSHOT_UNAVAILABLE');
});
test('batch stops on failure and preserves completed steps', async () => {
  const chrome = mockChrome(); let calls = 0;
  chrome.scripting.executeScript = (_options, cb) => { calls++; cb([{ result: calls === 2 ? { error: 'STALE_REF' } : { performed: true } }]); };
  const result = await runBatch({ tabId: 1, steps: [{ action: 'click', selector: '#a' }, { action: 'click', selector: '#b' }, { action: 'click', selector: '#c' }], observe: false });
  expect(calls).toBe(2); expect(result.completed).toBe(1); expect(result.results).toHaveLength(2); expect(result.error).toBe('STALE_REF');
});
