import { afterAction, runPage } from "../observation.js";
import { navigationWait, waitVisible, documentReady } from "../waits.js";
import { resolveTabSpec, tabsUpdate, type TabSpec } from "../chromeApi.js";

export async function navigateTo(params: Record<string, unknown>): Promise<unknown> {
  const url = params.url as string;
  const tabId = await resolveTabSpec(params as TabSpec);
  await tabsUpdate(tabId, { url });
  return { tabId, url };
}

export async function navigateAndWait(params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabSpec(params as TabSpec);
  const pinned = { ...params, tabId };
  const timeout = Math.min(25000, Number(params.timeout ?? 10000)), deadline = Date.now() + timeout;
  const before = params.waitUntil === "domcontentloaded" ? await runPage({ ...pinned, frameId: 0 }, "identity") : null;
  const wait = navigationWait(tabId, timeout);
  try {
    await tabsUpdate(tabId, { url: params.url as string });
    if (before) await documentReady(pinned, before, deadline);
    else await wait.promise;
    await waitVisible(pinned, deadline);
    return afterAction(pinned, { tabId, navigated: true });
  } catch (e) { return afterAction(pinned, { tabId, error: String(e), actionMayHaveOccurred: true }); }
  finally { wait.cancel(); }
}

export async function goBack(params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabSpec(params as TabSpec);
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.goBack(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  return { tabId };
}

export async function goForward(params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabSpec(params as TabSpec);
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.goForward(tabId, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  return { tabId };
}

export async function reload(params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabSpec(params as TabSpec);
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  return { tabId };
}
