# Host one LiveMCP hub

Version 2.2 serves two endpoints from one process and port:

- `https://browser.example.com/mcp`: MCP Streamable HTTP for agents.
- `wss://browser.example.com/browser`: extension WebSocket.

The hub routes actions; Chrome stays on your computer with your existing profiles. No browser runs on the server. Local mode remains available below.

## Docker + HTTPS

1. Clone this repository and check out `v2.3.0` (or use the release source archive).
2. Copy `.env.example` to `.env`. Set `LIVEMCP_PUBLIC_URL` to your HTTPS origin, without a path. Generate `LIVEMCP_TOKEN` with `openssl rand -hex 32` and paste it into `.env`.
3. Run `docker compose up -d --build`. The container runs as a non-root user and exposes the hub only on the host's loopback port 17691.
4. Point your domain at the host. Install Caddy on the host, replace the domain in `deploy/Caddyfile`, and use that configuration. Caddy provides HTTPS and forwards WebSocket upgrades. Open ports 80/443 for Caddy; keep 17691 private.
5. Load the v2.3 extension, set **Server URL** to `wss://browser.example.com/browser`, set a useful **Browser name**, and paste the token into **Access token**. Click **Connect**.
6. Configure your agent's MCP client to use `https://browser.example.com/mcp` and an `Authorization: Bearer YOUR_TOKEN` request header.

For clients using `mcpServers` with URL/header configuration (exact keys depend on the client):

```json
{
  "mcpServers": {
    "livemcp": {
      "url": "https://browser.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

This is manually configured bearer authentication, not an OAuth discovery/login server. Your MCP client must support Streamable HTTP and configured authorization headers. Prefer its secret/environment variable facility over committing credentials to configuration files. Browser tokens go in the extension's password field, never in the URL. The extension stores them in profile-local extension storage and requires WSS for tokens sent off loopback.

For a platform that already terminates HTTPS, build the Dockerfile, supply both environment variables, expose container port 17691, and forward the original Host header and WebSocket upgrades. Use `/healthz` for health checks. Set a proxy request timeout of at least 60 seconds. Do not rewrite `/mcp` or `/browser`. Do not expose the backend over unencrypted public HTTP.

## Run directly on a server

```sh
npm ci
npm run build:server
# Set LIVEMCP_TOKEN and LIVEMCP_PUBLIC_URL in your service's environment.
LIVEMCP_HOST=127.0.0.1 LIVEMCP_DISABLE_IPC=1 node server/dist/hub.js
```

Use the same HTTPS reverse proxy. Use `LIVEMCP_HOST=0.0.0.0` when your platform needs a network listener. Any non-loopback bind or configured public URL requires authentication; the process fails early if credentials are missing. Tokens must have at least 32 non-whitespace characters.

## Local setup stays simple

```sh
npm ci
npm run build
npm run hub
```

Extension URL: `ws://127.0.0.1:17691/browser`. Leave the token blank. Existing `ws://127.0.0.1:17691/` connections still work in unauthenticated local mode. Existing stdio configuration (`node /absolute/path/server/dist/index.js`) works through the Unix socket unchanged. URL-capable clients can instead use `http://127.0.0.1:17691/mcp` with no token.

Local mode is for trusted local processes. To require authentication locally, set `LIVEMCP_TOKEN` for **both hub and stdio client**, and use it in the extension. HTTP clients send it as a bearer header. Unix sockets are created with mode `0600`. If a hub was killed without cleanup, remove its stale socket only after confirming no hub is using it. Occupied ports now fail explicitly instead of silently changing the configured endpoint.

## Separate accounts and profiles

For one person's browsers, `LIVEMCP_TOKEN` is sufficient. For separate owners, set `LIVEMCP_ACCOUNTS` to a JSON array **instead of** `LIVEMCP_TOKEN` on the hub:

```json
[
  { "id": "alice", "agentToken": "ALICE_RANDOM_AGENT_TOKEN", "browserToken": "ALICE_RANDOM_BROWSER_TOKEN" },
  { "id": "bob", "agentToken": "BOB_RANDOM_AGENT_TOKEN", "browserToken": "BOB_RANDOM_BROWSER_TOKEN" }
]
```

Replace every placeholder with a distinct random token of at least 32 characters. Supply the JSON through your platform's secret environment settings. If using Compose, replace its `LIVEMCP_TOKEN` environment entry with `LIVEMCP_ACCOUNTS: ${LIVEMCP_ACCOUNTS:?Set account credentials}`. An account's agents can access all browsers connected with that account's browser token. Account IDs and tokens never appear in browser listings. Different accounts can have the same browser ID without sharing access. Distinct role tokens prevent browser credentials from authenticating as an agent.

Each Chrome profile retains its browser ID and display name. Agents call `list_browsers` and `select_browser`; each MCP session retains an independent choice. Selection does not reserve tabs. Agents using the same profile should retain separate tab IDs and avoid changing each other's tabs.

For authenticated local stdio access in this mode, set the client's `LIVEMCP_TOKEN` to that account's **agentToken**.

## Operation and limits

- Run **one replica**. Browser connections and agent sessions are in memory; this release does not distribute state across hubs. A second replica behind a load balancer cannot route the first one's browsers.
- HTTP sessions expire after 30 minutes without requests. Restarting the hub clears them; the MCP client must initialize a new session and rediscover/select a browser. Extension connections retry automatically. Browser actions are never automatically replayed after a disconnect.
- Rotate credentials by changing the environment and restarting the hub, then updating agents/extensions. No account management UI or OAuth flow is included.
- Host and Origin validation protects the endpoints. Set `LIVEMCP_PUBLIC_URL` correctly even when the reverse proxy reaches a loopback listener. The hub does not trust forwarded headers to bypass checks.
- The hub can read and control connected, logged-in browser profiles. Host it on infrastructure you trust and keep access tokens private. TLS terminates at the proxy; traffic from proxy to hub must stay on a trusted host/network.
- Bounds: 100 HTTP sessions per account, 1,000 total; 100 pending actions per session, 1,000 per account; 1,000 WebSocket connections; 4 MB HTTP request bodies; 32 MB browser messages. Unauthenticated WebSockets have five seconds to send their authenticated hello.
- `/healthz` reports process health, not whether any browser is connected. Use `list_browsers` to check availability.

Validation covers the actual HTTP MCP SDK client, account isolation, WebSocket authentication and the built extension in Chromium. Container files are supplied for deployment; validate them on your Docker host before exposing the service.
