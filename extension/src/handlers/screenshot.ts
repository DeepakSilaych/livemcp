import { resolveTabSpec, tabsGet, tabsQuery, type TabSpec } from '../chromeApi.js';
let tail: Promise<unknown> = Promise.resolve();
let lastCapture = 0;
export function capture(params: Record<string, unknown>): Promise<any> {
  const task = tail.catch(() => {}).then(async () => {
    const tabId = await resolveTabSpec(params as TabSpec);
    const delay = 550 - (Date.now() - lastCapture);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (typeof params.__deadline === 'number' && Date.now() >= params.__deadline) throw new Error('Screenshot deadline exceeded in queue.');
    const tab = await tabsGet(tabId);
    const active = await tabsQuery({ active: true, windowId: tab.windowId });
    if (active[0]?.id !== tabId) throw new Error('SCREENSHOT_UNAVAILABLE: Target must be the active tab in its window. DOM observations work on background tabs.');
    lastCapture = Date.now();
    const dataUrl: string = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' }, data => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(data));
    });
    const after = await tabsGet(tabId);
    const activeAfter = await tabsQuery({ active: true, windowId: tab.windowId });
    if (activeAfter[0]?.id !== tabId || tab.url !== after.url) throw new Error('SCREENSHOT_CHANGED: Tab changed during capture. Retry.');
    return { tabId, url: after.url, mimeType: 'image/png', dataUrl, capturedAt: Date.now() };
  });
  tail = task; return task;
}
