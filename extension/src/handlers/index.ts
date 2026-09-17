import { pressKey, selectOption } from './input.js';
import { waitFor } from './readiness.js';
import { runPage } from '../observation.js';
import { debuggerHealth, resetDebugger } from '../debuggerSession.js';
import { runBatch, listFrames } from "./batch.js";
import { resolveTabSpec, type TabSpec } from "../chromeApi.js";
import type { BridgeAction } from "@livemcp/shared";
import * as consoleH from "./console.js";
import * as content from "./content.js";
import * as cookies from "./cookies.js";
import * as interact from "./interact.js";
import * as navigate from "./navigate.js";
import * as network from "./network.js";
import * as screenshot from "./screenshot.js";
import * as snapshot from "./snapshot.js";
import * as tabs from "./tabs.js";

const registry: Record<BridgeAction, (p: Record<string, unknown>) => Promise<unknown>> = {
  "interact.pressKey": pressKey,
  "interact.selectOption": selectOption,
  "browser.wait": waitFor,
  "content.readState": p => runPage(p, 'readState'),
  "browser.health": tabHealth,
  "tabs.list": () => tabs.listTabs(),
  "tabs.getActive": () => tabs.getActiveTab(),
  "tabs.switch": tabs.switchTab,
  "tabs.close": tabs.closeTab,
  "tabs.create": tabs.createTab,
  "content.getPage": content.getPage,
  "content.getSelection": content.getSelection,
  "screenshot.capture": screenshot.capture,
  "navigate.to": navigate.navigateTo,
  "navigate.back": navigate.goBack,
  "navigate.forward": navigate.goForward,
  "navigate.reload": navigate.reload,
  "navigate.andWait": navigate.navigateAndWait,
  "network.startCapture": network.startCapture,
  "network.stopCapture": network.stopCapture,
  "network.getCaptured": network.getCaptured,
  "network.getBody": network.getBody,
  "console.startCapture": consoleH.startCapture,
  "console.stopCapture": consoleH.stopCapture,
  "console.getLogs": consoleH.getLogs,
  "interact.click": interact.click,
  "interact.type": interact.typeText,
  "interact.fillForm": interact.fillForm,
  "interact.clickAndWait": interact.clickAndWait,
  "interact.scroll": interact.scroll,
  "cookies.get": cookies.getCookies,
  "cookies.getLocalStorage": cookies.getLocalStorage,
  "page.snapshot": snapshot.getPageSnapshot,
  "browser.batch": runBatch,
  "browser.frames": listFrames,
};

const queues = new Map<number, Promise<unknown>>();
const running = new Map<number, { action: string; startedAt: number; deadline: number }>();
async function tabHealth(params: Record<string, unknown>) {
  const tabId = await resolveTabSpec(params as TabSpec), active = running.get(tabId);
  if (params.recoverDebugger && queues.has(tabId)) return { tabId, busy: true, error: 'TAB_BUSY: Cannot reset debugger while an operation is queued or running.', active };
  if (params.recoverDebugger) {
    const reset = resetDebugger(tabId); queues.set(tabId, reset);
    try { await reset; } finally { if (queues.get(tabId) === reset) queues.delete(tabId); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await Promise.race([runPage({ tabId }, 'identity'), new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('TAB_UNRESPONSIVE')),2000); })]);
    return { tabId, responsive: true, busy: queues.has(tabId), stalled: Boolean(active && Date.now() > active.deadline), active, debugger: debuggerHealth(tabId), page };
  } catch (e) { return { tabId, responsive: false, busy: queues.has(tabId), active, code: 'TAB_UNRESPONSIVE', error: String(e) }; }
  finally { clearTimeout(timer); }
}

export async function dispatch(action: BridgeAction, params: Record<string, unknown>): Promise<unknown> {
  const fn = registry[action];
  if (!fn) throw new Error(`Unknown action: ${action}`);
  if (action === 'browser.health') return tabHealth(params);
  // Pin targeting before entering the queue. Every operation on a tab sees ordered state.
  if (/^(interact\.|navigate\.|page\.|content\.|screenshot\.|browser\.|network\.|console\.|tabs\.(?:switch|close)$)/.test(action)) {
    const tabId = await resolveTabSpec(params as TabSpec);
    const task = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (typeof params.__deadline === 'number' && Date.now() >= params.__deadline) throw new Error('QUEUE_TIMEOUT: Request expired in queue; no action performed.');
      const remaining = typeof params.__deadline === 'number' ? Math.max(1, params.__deadline - Date.now()) : 62000;
      running.set(tabId, { action, startedAt: Date.now(), deadline: Date.now() + remaining });
      return fn({ ...params, tabId, timeout: Math.min(Number(params.timeout ?? (action === 'browser.batch' ? 60000 : action === 'browser.wait' || action === 'navigate.andWait' ? 10000 : 5000)), remaining) }).finally(() => running.delete(tabId));
    });
    queues.set(tabId, task);
    try { return await task; } finally { if (queues.get(tabId) === task) queues.delete(tabId); }
  }
  return fn(params);
}
