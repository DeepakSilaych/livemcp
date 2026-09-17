import { executeScript, resolveTabSpec, type TabSpec } from './chromeApi.js';
import { pageRuntime } from './pageRuntime.js';
export async function runPage(params: Record<string, unknown>, command: string, extra = {}): Promise<any> {
  const tabId = await resolveTabSpec(params as TabSpec);
  const frameId = Number(params.frameId ?? 0);
  const result = await executeScript(tabId, pageRuntime, [command, { ...params, ...extra }], frameId);
  return { ...result, tabId, frameId };
}
export async function observe(params: Record<string, unknown>): Promise<any> { return runPage(params, 'observe'); }
export async function afterAction(params: Record<string, unknown>, result: any): Promise<any> {
  if (params.observe === false) return result;
  try { return { ...result, observation: await observe({ ...params, selector: params.observationSelector, maxNodes: params.maxNodes ?? 30, since: params.since, maxChars: params.maxChars ?? 1500 }) }; }
  catch (e) { return { ...result, observationError: String(e) }; }
}
