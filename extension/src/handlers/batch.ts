import { pressKey, selectOption } from './input.js';
import { waitFor } from './readiness.js';
import { resolveTabSpec, type TabSpec } from '../chromeApi.js';
import { observe, runPage } from '../observation.js';
import * as interact from './interact.js';
import * as navigate from './navigate.js';
import { getPage } from './content.js';
import { waitVisible } from '../waits.js';
const actions: Record<string, (p: Record<string, unknown>) => Promise<any>> = {
  click: interact.click, type: interact.typeText, fill: interact.fillForm, scroll: interact.scroll,
  clickAndWait: interact.clickAndWait, navigate: navigate.navigateAndWait, observe, content: getPage,
  pressKey, selectOption, waitFor,
  wait: async p => { await waitVisible({ ...p, waitFor: p.selector }, Date.now() + Math.min(60000, Number(p.timeout ?? 10000))); return { ready: true }; },
};
export async function runBatch(params: Record<string, unknown>): Promise<any> {
  const steps = params.steps as Record<string, unknown>[];
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('Batch must contain 1–20 steps.');
  for (const step of steps) if (!actions[String(step.action)]) throw new Error(`Unknown batch action: ${step.action}`);
  const tabId = await resolveTabSpec(params as TabSpec);
  // Parse every selector before any step runs, including waits after mutations.
  // Do not resolve refs here: earlier steps may navigate or create elements.
  const selectors = [...steps.flatMap(step => [step.selector, step.waitFor, step.form, step.optionSelector,
    ...(Array.isArray(step.fields) ? step.fields.map((f: any) => f.selector) : [])]), params.observationSelector].filter(value => value !== undefined);
  try { if (selectors.length) await runPage({ ...params, tabId }, 'validateSelectors', { selectors }); }
  catch (e) { return { tabId, completed: 0, results: [], error: String(e), phase: 'preflight', actionMayHaveOccurred: false }; }
  const results: any[] = [], started = Date.now();
  const budget = Math.min(Number(params.timeout ?? 60000), 60000, typeof params.__deadline === 'number' ? Math.max(1, params.__deadline - started) : 60000);
  let outputChars = 0;
  for (let i = 0; i < steps.length; i++) {
    if (Date.now() - started > budget) return { tabId, completed: i, results, error: 'BATCH_DEADLINE', nextStep: i };
    const step = steps[i];
    try {
      const result = await actions[String(step.action)]({ ...step, tabId, frameId: params.frameId ?? 0, observe: false, maxChars: step.maxChars ?? 1500, maxNodes: 30, __deadline: started + budget, timeout: Math.min(Number(step.timeout ?? 5000), budget - (Date.now() - started)) });
      const size = JSON.stringify(result).length;
      if (outputChars + size > 18000) {
        results.push({ step: i, performed: result?.performed, outputTruncated: true, error: result?.error });
      } else { results.push({ step: i, ...result }); outputChars += size; }
      if (result?.error) return { tabId, completed: i, nextStep: i, results, error: result.error, actionMayHaveOccurred: i > 0 || result.actionMayHaveOccurred !== false };
    } catch (e) { return { tabId, completed: i, nextStep: i, results, error: String(e), actionMayHaveOccurred: true }; }
  }
  let observation;
  try { observation = params.observe === false ? undefined : await observe({ ...params, tabId, selector: params.observationSelector, maxNodes: params.maxNodes ?? 30, maxChars: params.maxChars ?? 1500 }); }
  catch (e) { return { tabId, completed: steps.length, results, observationError: String(e) }; }
  return { tabId, completed: steps.length, results, observation };
}
export async function listFrames(params: Record<string, unknown>): Promise<any> {
  const tabId = await resolveTabSpec(params as TabSpec);
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ url: location.href, title: document.title }) });
  return { tabId, frames: frames.map(f => ({ frameId: f.frameId, documentId: f.documentId, ...f.result })), note: 'Only frames accessible to this extension are listed.' };
}
