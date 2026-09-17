import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge.js';
import { tabSpecSchema } from './helpers.js';
import { imageResult, errText } from '../toolResult.js';
export function registerScreenshotTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('take_screenshot', { description: 'Return a viewport image of the target tab, including background tabs. Use for visual/layout tasks or ambiguous DOM state. Does not switch tabs.', inputSchema: tabSpecSchema }, async args => {
    try { return imageResult(await bridge.request('screenshot.capture', args)); } catch (e) { return errText(String(e)); }
  });
}
