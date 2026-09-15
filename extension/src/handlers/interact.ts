import { resolveTabSpec, type TabSpec } from '../chromeApi.js';
import { afterAction, runPage } from '../observation.js';
import { navigationWait, waitVisible } from '../waits.js';
export async function click(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'click')); }
export async function typeText(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'type')); }
export async function fillForm(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'fill')); }
export async function scroll(params: Record<string, unknown>): Promise<any> { return afterAction(params, await runPage(params, 'scroll')); }
export async function clickAndWait(params: Record<string, unknown>): Promise<any> {
  const tabId = await resolveTabSpec(params as TabSpec), pinned = { ...params, tabId };
  const timeout = Math.min(25000, Number(params.timeout ?? 5000)), deadline = Date.now() + timeout;
  const wait = params.waitForNavigation ? navigationWait(tabId, timeout) : null;
  let result: any;
  try {
    result = await runPage(pinned, 'click');
    if (wait) await wait.promise;
    await waitVisible(pinned, deadline);
    return afterAction(pinned, result);
  } catch (e) {
    return afterAction(pinned, { ...result, error: String(e), actionMayHaveOccurred: true });
  } finally { wait?.cancel(); }
}
