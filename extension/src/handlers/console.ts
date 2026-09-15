import * as dbg from "../debuggerSession.js";

export async function startCapture(params: Record<string, unknown>): Promise<unknown> {
  const tabId = params.tabId as number;
  return dbg.startConsole(tabId);
}

export async function stopCapture(params: Record<string, unknown>): Promise<unknown> {
  const tabId = params.tabId as number;
  return dbg.stopConsole(tabId);
}

export async function getLogs(params: Record<string, unknown>): Promise<unknown> {
  const tabId = params.tabId as number;
  const clearAfter = Boolean(params.clearAfter);
  return dbg.getConsole(tabId, clearAfter, params);
}
