import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from '../bridge.js';
import { z } from 'zod';
import { tabSpecSchema, observationSchema } from './helpers.js';
import { errText, imageResult } from '../toolResult.js';
export function registerSnapshotTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('get_page_snapshot', {
    description: 'Bounded page observation with persistent @refs, control state and document/version IDs. DOM-only by default. Optional screenshot is a real image and uses per-tab CDP without switching focus. Supports scopes, paging and deltas.',
    inputSchema: { ...tabSpecSchema, ...observationSchema, screenshot: z.boolean().optional() },
  }, async args => { try { return imageResult(await bridge.request('page.snapshot', args)); } catch (e) { return errText(String(e)); } });
}
