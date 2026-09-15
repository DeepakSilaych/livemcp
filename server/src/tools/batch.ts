import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { bridgeCall, tabSpecSchema, actionObservationSchema } from './helpers.js';
import { fieldSchema, waitSchema } from './interact.js';
const selector = z.string();
const step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector }),
  z.object({ action: z.literal('type'), selector, text: z.string(), clear: z.boolean().optional() }),
  z.object({ action: z.literal('fill'), fields: z.array(fieldSchema).min(1).max(100), submit: z.boolean().optional(), form: z.string().optional() }),
  z.object({ action: z.literal('scroll'), selector: selector.optional(), direction: z.enum(['up','down','left','right']), amount: z.number().min(1).max(10000).optional() }),
  z.object({ action: z.literal('clickAndWait'), selector, ...waitSchema }),
  z.object({ action: z.literal('navigate'), url: z.string().url(), waitUntil: z.enum(['domcontentloaded', 'complete']).optional(), waitFor: selector.optional(), timeout: z.number().min(1).max(25000).optional() }),
  z.object({ action: z.literal('wait'), selector, timeout: z.number().min(1).max(10000).optional() }),
  z.object({ action: z.literal('observe'), selector: selector.optional(), maxChars: z.number().min(500).max(6000).optional() }),
  z.object({ action: z.literal('content'), selector: selector.optional(), format: z.enum(['text','aria']).optional(), maxChars: z.number().min(500).max(6000).optional() }),
]);
export function registerBatchTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('run_browser_actions', { description: 'Execute 1–20 known sequential steps on one tab without extra model turns. Stops at the first error and reports completed steps; never rolls back. Use observed references only; references expire on navigation. Keep steps short (24-second budget). Returns final state by default.', inputSchema: { ...tabSpecSchema, ...actionObservationSchema, steps: z.array(step).min(1).max(20) } }, async args => bridgeCall(bridge, 'browser.batch', args));
  mcp.registerTool('list_frames', { description: 'List accessible frame IDs and URLs. Pass frameId to observations/actions to target an iframe.', inputSchema: tabSpecSchema }, async args => bridgeCall(bridge, 'browser.frames', args));
}
