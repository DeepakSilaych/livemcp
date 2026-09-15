import { observe, runPage } from '../observation.js';
import { capture } from './screenshot.js';
export async function getPageSnapshot(params: Record<string, unknown>): Promise<any> {
  const observation = await observe(params);
  if (!params.screenshot) return observation;
  try {
    const shot = await capture({ ...params, tabId: observation.tabId });
    const identity = await runPage({ ...params, tabId: observation.tabId }, 'identity');
    if (identity.documentId !== observation.documentId || identity.url !== observation.url || identity.revision !== observation.revision) throw new Error('Document changed during observation; refresh.');
    return { ...observation, screenshot: shot.dataUrl, capturedAt: shot.capturedAt };
  } catch (e) { return { ...observation, screenshotError: String(e) }; }
}
