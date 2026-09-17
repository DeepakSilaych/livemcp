import { resolveTabSpec, tabsGet, type TabSpec } from '../chromeApi.js';
import { command } from '../debuggerSession.js';
import { runPage } from '../observation.js';
export async function capture(params: Record<string, unknown>): Promise<any> {
  const tabId = await resolveTabSpec(params as TabSpec);
  const before = await runPage({ tabId }, 'identity');
  const result = await command(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const after = await runPage({ tabId }, 'identity');
  if (before.documentId !== after.documentId || before.url !== after.url) throw new Error('SCREENSHOT_CHANGED: Document changed during capture; refresh.');
  const tab = await tabsGet(tabId);
  return { tabId, url: tab.url, mimeType: 'image/png', dataUrl: `data:image/png;base64,${result.data}`, capturedAt: Date.now(), method: 'cdp' };
}
