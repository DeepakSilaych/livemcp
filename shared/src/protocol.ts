export const DEFAULT_WS_PORT = 17691;

export const BRIDGE_ACTIONS = [
  "tabs.list",
  "tabs.getActive",
  "tabs.switch",
  "tabs.close",
  "tabs.create",
  "content.getPage",
  "content.getSelection",
  "screenshot.capture",
  "navigate.to",
  "navigate.back",
  "navigate.forward",
  "navigate.reload",
  "navigate.andWait",
  "network.startCapture",
  "network.stopCapture",
  "network.getCaptured",
  "network.getBody",
  "console.startCapture",
  "console.stopCapture",
  "console.getLogs",
  "interact.click",
  "interact.type",
  "interact.fillForm",
  "interact.clickAndWait",
  "interact.scroll",
  "interact.pressKey",
  "interact.selectOption",
  "browser.wait",
  "browser.health",
  "content.readState",
  "cookies.get",
  "cookies.getLocalStorage",
  "page.snapshot",
  "browser.batch",
  "browser.frames",
] as const;

export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

export type BridgeRequest = {
  id: string;
  action: BridgeAction;
  params?: Record<string, unknown>;
};

export type BridgeResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export function isBridgeRequest(v: unknown): v is BridgeRequest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const p = o.params;
  const paramsOk =
    p === undefined || (typeof p === "object" && p !== null && !Array.isArray(p));
  return typeof o.id === "string" && typeof o.action === "string" && paramsOk;
}

export function isBridgeResponse(v: unknown): v is BridgeResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && ("result" in o || "error" in o);
}

/** Budget includes execution, not unbounded queueing. Transport gets a small grace. */
export function executionBudget(action: string, params: Record<string, any>): number {
  if (action === 'browser.batch') return Math.min(60000, Math.max(1000, Number(params.timeout ?? 60000)));
  if (action === 'browser.wait' || action === 'interact.clickAndWait' || action === 'navigate.andWait') return Math.min(60000, Math.max(1000, Number(params.timeout ?? 10000))) + 2000;
  return 28000;
}
