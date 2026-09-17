import type { Bridge } from '../bridge.js';
import type { BridgeAction } from '@livemcp/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { errText, okJson } from '../toolResult.js';
export const tabSpecSchema = {
  tabId: z.number().int().nonnegative().optional().describe('Retain the tab ID after discovery; stable for its lifetime.'),
  tabUrl: z.string().optional().describe('Discover a unique tab by URL substring. Ambiguity returns candidates.'),
  tabTitle: z.string().optional().describe('Discover a unique tab by title substring; combined with tabUrl when both are supplied.'),
  frameId: z.number().int().nonnegative().optional().describe('Frame from list_frames; default main frame (0).'),
};
export const observationSchema = {
  selector: z.string().optional().describe('Scope to a unique CSS selector or @ref, including open shadow roots.'),
  query: z.string().max(200).optional().describe('Filter nodes by accessible name substring.'),
  maxChars: z.number().int().min(500).max(50000).optional(),
  maxNodes: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  visibleOnly: z.boolean().optional(),
  since: z.string().optional().describe('Version of a retained observation. Returns a delta, or a full reset if unavailable.'),
};
export const actionObservationSchema = {
  observe: z.boolean().optional().describe('Return compact state after acting; default true, at most 1500 text characters and 30 nodes unless overridden.'),
  since: z.string().optional().describe('Explicit baseline version for changed-only action observation. Retain that baseline in context; omit after compaction.'),
  maxNodes: z.number().int().min(1).max(500).optional().describe('Action observation node limit; default 30.'),
  observationSelector: z.string().optional().describe('Scope the returned state, e.g. a dialog or result table.'),
  maxChars: z.number().int().min(500).max(50000).optional(),
};
export async function bridgeCall(bridge: Bridge, action: BridgeAction, params: Record<string, unknown> = {}): Promise<CallToolResult> {
  try { return okJson(await bridge.request(action, params)); }
  catch (e) { return errText(e instanceof Error ? e.message : String(e)); }
}
