import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { bridgeCall, tabSpecSchema, observationSchema } from './helpers.js';
export function registerContentTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('get_page_content', {
    description: 'Read bounded page content. aria: controls/structure with @refs; text: prose; html: markup; markdown: text alias. Scope with selector; continue using nextOffset. Text/HTML offsets are characters; aria offsets are nodes.',
    inputSchema: { ...tabSpecSchema, ...observationSchema, format: z.enum(['aria', 'text', 'html', 'markdown']).optional() },
  }, async args => bridgeCall(bridge, 'content.getPage', args));
  mcp.registerTool('get_selected_text', { description: 'Read current selection (up to 12000 characters).', inputSchema: tabSpecSchema }, async args => bridgeCall(bridge, 'content.getSelection', args));
}
