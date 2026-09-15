import { executeScript, resolveTabSpec, type TabSpec } from '../chromeApi.js';
import { observe, runPage } from '../observation.js';
export async function getPage(params: Record<string, unknown>): Promise<unknown> {
  return !params.format || params.format === 'aria' ? observe(params) : runPage(params, 'content');
}
export async function getSelection(params: Record<string, unknown>): Promise<unknown> {
  const tabId = await resolveTabSpec(params as TabSpec);
  return executeScript(tabId, () => window.getSelection()?.toString().slice(0, 12000) ?? '', [], Number(params.frameId ?? 0));
}
