import { runPage } from '../observation.js';
import { waitNetworkIdle } from '../debuggerSession.js';
export async function waitFor(params: Record<string, unknown>): Promise<any> {
  if ((params.kind === 'text' && (typeof params.text !== 'string' || !params.text)) || (params.kind === 'url' && (typeof params.url !== 'string' || !params.url)) || (params.kind === 'selector' && !params.selector)) throw new Error('INVALID_ARGUMENT: Wait requires text, url or selector for its selected kind.');
  const timeout = Math.min(60000, Math.max(1, Number(params.timeout ?? 10000)));
  const started = Date.now(), deadline = Math.min(started + timeout, Number(params.__deadline ?? Infinity));
  if (params.kind === 'networkIdle') return waitNetworkIdle(Number(params.tabId), deadline - started, Number(params.quietMs ?? 500));
  if (params.selector) await runPage(params, 'validateSelectors', { selectors: [params.selector] });
  while (Date.now() < deadline) {
    try {
      const result = await runPage(params, 'checkWait');
      if (result.ready) return { ...result, waitedMs: Date.now() - started };
    } catch (e) {
      const message = String(e);
      if (!/NOT_FOUND|STALE_REF|context.*invalidated|frame.*removed|No frame/i.test(message)) throw e;
    }
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  return { error: 'WAIT_TIMEOUT: Readiness condition was not met.', code: 'WAIT_TIMEOUT', actionMayHaveOccurred: false, waitedMs: Date.now() - started };
}
