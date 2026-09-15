import { runPage } from './observation.js';
/** Install before the action. Completion is tied to a loading or URL transition. */
export function navigationWait(tabId: number, timeout: number) {
  let timer: ReturnType<typeof setTimeout>;
  let started = false, settled = false;
  let finish: (error?: Error) => void = () => {};
  const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId) return;
    if (info.status === 'loading' || info.url) started = true;
    if (started && (info.status === 'complete' || (info.url && info.status !== 'loading'))) finish();
  };
  const closed = (id: number) => { if (id === tabId) finish(new Error('TAB_CLOSED')); };
  const promise = new Promise<void>((resolve, reject) => {
    finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener); chrome.tabs.onRemoved.removeListener(closed);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener); chrome.tabs.onRemoved.addListener(closed);
    timer = setTimeout(() => finish(new Error(`NAVIGATION_TIMEOUT after ${timeout}ms; inspect current state before retrying the action.`)), timeout);
  });
  void promise.catch(() => {});
  return { promise, cancel: () => finish() };
}
export async function waitVisible(params: Record<string, unknown>, deadline: number): Promise<void> {
  if (!params.waitFor) return;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('WAIT_TIMEOUT');
  await runPage({ ...params, selector: params.waitFor, timeout: remaining }, 'wait');
}
/** Poll document identity, never an arbitrary fixed sleep after an action. */
export async function documentReady(params: Record<string, unknown>, before: any, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const current = await runPage({ ...params, frameId: 0 }, 'identity');
      if ((current.documentId !== before.documentId || current.url !== before.url) && current.readyState !== 'loading') return;
    } catch { /* Execution contexts may disappear while a navigation commits. */ }
    await new Promise(resolve => setTimeout(resolve, Math.min(80, Math.max(1, deadline - Date.now()))));
  }
  throw new Error('DOCUMENT_READY_TIMEOUT; inspect current state before retrying.');
}
