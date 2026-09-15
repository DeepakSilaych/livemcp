import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { bridgeCall } from "./helpers.js";

export function registerConsoleTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool(
    "start_console_capture",
    {
      description: "Attach debugger and start recording console log entries for a tab",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "console.startCapture", { tabId }),
  );
  mcp.registerTool(
    "stop_console_capture",
    {
      description: "Stop console recording for the tab",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "console.stopCapture", { tabId }),
  );
  mcp.registerTool(
    "get_console_logs",
    {
      description: "Return captured console entries for a tab",
      inputSchema: {
        tabId: z.number().int().positive(),
        clearAfter: z.boolean().optional(),
        level: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) =>
      bridgeCall(bridge, "console.getLogs", {
        ...args,
        tabId: args.tabId,
        clearAfter: args.clearAfter ?? false,
      }),
  );
}
