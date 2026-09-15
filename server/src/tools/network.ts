import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { bridgeCall } from "./helpers.js";

export function registerNetworkTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('get_response_body', { description: 'Fetch a captured text response body on demand, bounded to maxChars. Requires debugger attachment; may be unavailable after stopping capture.', inputSchema: { tabId: z.number().int().nonnegative(), requestId: z.string(), maxChars: z.number().int().min(100).max(50000).optional() } }, async args => bridgeCall(bridge, 'network.getBody', args));
  mcp.registerTool(
    "start_network_capture",
    {
      description: "Attach debugger and start recording network requests for a tab",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "network.startCapture", { tabId }),
  );
  mcp.registerTool(
    "stop_network_capture",
    {
      description: "Stop network recording and detach debugger for that capture on the tab",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "network.stopCapture", { tabId }),
  );
  mcp.registerTool(
    "get_captured_requests",
    {
      description: "Return captured HTTP requests for a tab",
      inputSchema: {
        tabId: z.number().int().positive(),
        clearAfter: z.boolean().optional(),
        url: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) =>
      bridgeCall(bridge, "network.getCaptured", {
        ...args,
        tabId: args.tabId,
        clearAfter: args.clearAfter ?? false,
      }),
  );
}
