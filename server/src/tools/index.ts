import { registerBatchTools } from "./batch.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../bridge.js";
import { registerConsoleTools } from "./console.js";
import { registerContentTools } from "./content.js";
import { registerCookieTools } from "./cookies.js";
import { registerInteractTools } from "./interact.js";
import { registerNavigateTools } from "./navigate.js";
import { registerNetworkTools } from "./network.js";
import { registerScreenshotTools } from "./screenshot.js";
import { registerSnapshotTools } from "./snapshot.js";
import { registerTabTools } from "./tabs.js";

export function registerAllTools(mcp: McpServer, bridge: Bridge): void {
  registerBatchTools(mcp, bridge);
  registerTabTools(mcp, bridge);
  registerContentTools(mcp, bridge);
  registerScreenshotTools(mcp, bridge);
  registerSnapshotTools(mcp, bridge);
  registerNavigateTools(mcp, bridge);
  registerNetworkTools(mcp, bridge);
  registerConsoleTools(mcp, bridge);
  registerInteractTools(mcp, bridge);
  registerCookieTools(mcp, bridge);
}
