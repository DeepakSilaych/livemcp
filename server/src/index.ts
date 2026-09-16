import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHubClient } from "./hub-client.js";
import { createMcpServer } from "./mcp-server.js";
await createMcpServer(createHubClient()).connect(new StdioServerTransport());
