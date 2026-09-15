import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { bridgeCall, tabSpecSchema, actionObservationSchema } from './helpers.js';
export const fieldSchema = z.object({ selector: z.string(), value: z.string() });
export const waitSchema = { waitForNavigation: z.boolean().optional(), waitFor: z.string().optional(), timeout: z.number().int().min(1).max(25000).optional() };
export function registerInteractTools(mcp: McpServer, bridge: Bridge): void {
  const common = { ...tabSpecSchema, ...actionObservationSchema };
  mcp.registerTool('click_element', { description: 'Click a unique CSS selector or observed @ref. Returns compact state. Rejects hidden, disabled and ambiguous targets.', inputSchema: { ...common, selector: z.string() } }, async args => bridgeCall(bridge, 'interact.click', args));
  mcp.registerTool('type_text', { description: 'Append text, or replace with clear=true, using a unique selector/@ref. Returns field state and observation.', inputSchema: { ...common, selector: z.string(), text: z.string(), clear: z.boolean().optional() } }, async args => bridgeCall(bridge, 'interact.type', args));
  mcp.registerTool('fill_form', { description: 'Fill fields together, validate targets first, and report field outcomes. submit=true submits their owning form if valid; use only when submission is requested. Never blindly retry a submission.', inputSchema: { ...common, fields: z.array(fieldSchema).min(1).max(100), submit: z.boolean().optional(), form: z.string().optional() } }, async args => bridgeCall(bridge, 'interact.fillForm', args));
  mcp.registerTool('click_and_wait', { description: 'Click once, await navigation and/or a visible selector under one deadline, and return state. On timeout inspect returned state before deciding whether to retry.', inputSchema: { ...common, selector: z.string(), ...waitSchema } }, async args => bridgeCall(bridge, 'interact.clickAndWait', args));
  mcp.registerTool('scroll_page', { description: 'Scroll the window or a unique container and return state.', inputSchema: { ...common, selector: z.string().optional(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(10000).optional() } }, async args => bridgeCall(bridge, 'interact.scroll', args));
}
