import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { bridgeCall, tabSpecSchema, actionObservationSchema } from './helpers.js';
import { fieldSchema, waitSchema } from './interact.js';
const selector = z.string().describe('Native CSS selector or observed @ref; Playwright :has-text(), text= and locator syntax are unsupported.');
const mode = z.enum(['trusted','dom']).optional();
const step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector, mode }),
  z.object({ action: z.literal('type'), selector, text: z.string(), clear: z.boolean().optional(), mode, allowReadonly: z.boolean().optional(), inputMethod: z.enum(['text','keys']).optional() }),
  z.object({ action: z.literal('fill'), fields: z.array(fieldSchema).min(1).max(100), submit: z.boolean().optional(), form: z.string().optional() }),
  z.object({ action: z.literal('scroll'), selector: selector.optional(), direction: z.enum(['up','down','left','right']), amount: z.number().min(1).max(10000).optional() }),
  z.object({ action: z.literal('clickAndWait'), selector, mode, ...waitSchema }),
  z.object({ action: z.literal('navigate'), url: z.string().url(), waitUntil: z.enum(['domcontentloaded', 'complete']).optional(), waitFor: selector.optional(), timeout: z.number().min(1).max(60000).optional() }),
  z.object({ action: z.literal('wait'), selector, timeout: z.number().min(1).max(60000).optional() }),
  z.object({ action: z.literal('pressKey'), key: z.string().min(1), selector: selector.optional(), modifiers: z.number().int().min(0).max(15).optional() }),
  z.object({ action: z.literal('selectOption'), selector: selector.optional(), text: z.string().optional(), value: z.string().optional(), optionSelector: selector.optional() }),
  z.object({ action: z.literal('waitFor'), kind: z.enum(['selector','text','url','networkIdle']), selector: selector.optional(), text: z.string().optional(), url: z.string().optional(), exact: z.boolean().optional(), quietMs: z.number().int().min(100).max(5000).optional(), timeout: z.number().int().min(1).max(60000).optional() }),
  z.object({ action: z.literal('observe'), selector: selector.optional(), maxChars: z.number().int().min(500).max(6000).optional().describe('Batch observation/content step budget: 500–6000 characters. For larger reads use standalone get_page_snapshot or get_page_content.') }),
  z.object({ action: z.literal('content'), selector: selector.optional(), format: z.enum(['text','aria']).optional(), maxChars: z.number().int().min(500).max(6000).optional().describe('Batch observation/content step budget: 500–6000 characters. For larger reads use standalone get_page_snapshot or get_page_content.') }),
]);
export function registerBatchTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('run_browser_actions', { description: 'Execute 1–20 known sequential steps on one tab without extra model turns. Stops at the first error and reports completed steps; never rolls back. Use observed references only; references expire on navigation. Each observe/content step maxChars must be 500–6000; larger values fail validation before any action. Use native CSS or observed @refs, never Playwright selector syntax. Keep steps short (60-second total budget). Returns final state by default.', inputSchema: { ...tabSpecSchema, ...actionObservationSchema, timeout: z.number().int().min(1).max(60000).optional().describe('Total batch execution budget, default 60000 ms; steps share this budget.'), steps: z.array(step).min(1).max(20) } }, async args => bridgeCall(bridge, 'browser.batch', args));
  mcp.registerTool('list_frames', { description: 'List accessible frame IDs and URLs. Pass frameId to observations/actions to target an iframe.', inputSchema: tabSpecSchema }, async args => bridgeCall(bridge, 'browser.frames', args));
}
