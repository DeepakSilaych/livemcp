import { trustedClick, trustedType } from './input.js';
import { resolveTabSpec, type TabSpec } from '../chromeApi.js';
import { afterAction, runPage } from '../observation.js';
import { navigationWait, waitVisible } from '../waits.js';
export async function click(params: Record<string, unknown>): Promise<any> { return afterAction(params, await (params.mode === 'dom' ? runPage(params, 'click') : trustedClick(params))); }
export async function typeText(params: Record<string, unknown>): Promise<any> { return params.mode === 'trusted' || params.allowReadonly ? trustedType(params) : afterAction(params, await runPage(params, 'type')); }
export async function fillForm(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'fill')); }
export async function scroll(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'scroll')); }
export async function clickAndWait(params: Record<string, unknown>): Promise<any> {
  const tabId = await resolveTabSpec(params as TabSpec), pinned = { ...params, tabId };
  const timeout = Math.min(60000, Number(params.timeout ?? 5000)), deadline = Date.now() + timeout;
  // Invalid wait selectors must fail before the click, too.
  try { await runPage(pinned, 'validateSelectors', { selectors: [params.selector, params.waitFor, params.observationSelector].filter(value => value !== undefined) }); }
  catch (e) { return { tabId, error: String(e), phase: 'preflight', actionMayHaveOccurred: false }; }
  const wait = params.waitForNavigation ? navigationWait(tabId, timeout) : null;
  let result: any;
  try {
    result = await (params.mode === 'dom' ? runPage(pinned, 'click') : trustedClick(pinned));
    if (result?.error) return afterAction(pinned, result);
    if (wait) await wait.promise;
    await waitVisible(pinned, deadline);
    return afterAction(pinned, result);
  } catch (e) {
    return afterAction(pinned, { ...result, error: String(e), actionMayHaveOccurred: true });
  } finally { wait?.cancel(); }
}
