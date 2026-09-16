import { okJson, errText } from "../toolResult.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { bridgeCall } from "./helpers.js";

export function registerTabTools(mcp: McpServer, bridge: Bridge): void {
  mcp.registerTool('list_browsers', { description: 'List connected browser profiles and this session’s selected browser. Call before selecting tabs when multiple browsers are connected.', inputSchema: {} }, async () => {
    try { if (!bridge.listBrowsers) return errText('Requires the hub transport.'); return okJson(await bridge.listBrowsers()); } catch (e) { return errText(String(e)); }
  });
  mcp.registerTool('select_browser', { description: 'Select a browser ID for this agent session. All later tab/page/capture calls use it. Other agent sessions keep their own selection. Rediscover tab IDs after switching browsers.', inputSchema: { browserId: z.string().min(1) } }, async ({ browserId }) => {
    try { if (!bridge.selectBrowser) return errText('Requires the hub transport.'); return okJson(await bridge.selectBrowser(browserId)); } catch (e) { return errText(String(e)); }
  });
  mcp.registerTool(
    "list_tabs",
    { description: "List open tabs in the user Chrome profile", inputSchema: z.object({}) },
    async () => bridgeCall(bridge, "tabs.list", {}),
  );
  mcp.registerTool(
    "get_active_tab",
    { description: "Get the active tab in the current window", inputSchema: z.object({}) },
    async () => bridgeCall(bridge, "tabs.getActive", {}),
  );
  mcp.registerTool(
    "switch_tab",
    {
      description: "Focus a tab by id",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "tabs.switch", { tabId }),
  );
  mcp.registerTool(
    "close_tab",
    {
      description: "Close a tab by id",
      inputSchema: { tabId: z.number().int().positive() },
    },
    async ({ tabId }) => bridgeCall(bridge, "tabs.close", { tabId }),
  );
  mcp.registerTool(
    "create_tab",
    {
      description: "Open a new tab with optional URL",
      inputSchema: { url: z.string().min(1).optional() },
    },
    async ({ url }) => bridgeCall(bridge, "tabs.create", url ? { url } : {}),
  );
}
