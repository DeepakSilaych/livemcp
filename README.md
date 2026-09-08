<p align="center">
  <img src="assets/logo.png" width="180" alt="LiveMCP logo" />
</p>

<h1 align="center">LiveMCP</h1>

<p align="center">
  Let your AI tools drive the Chrome you already have open: your tabs, your cookies, your logged-in sessions.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-green" alt="MCP compatible" /></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a>
</p>

---

## Why

Browser automation for AI usually means Playwright or a CDP-driven headless Chrome: a fresh profile with no cookies, so every task starts with a login form, a 2FA prompt, or a bot wall.

LiveMCP goes the other way. A small Manifest V3 extension runs inside the Chrome profile you already use, and an [MCP](https://modelcontextprotocol.io) server relays tool calls to it. The model sees the tabs you see and is logged in wherever you are. No second browser process is launched.

A hub daemon holds the single connection to the extension, so any number of AI chats (Claude Code, Cursor, anything that speaks MCP over stdio) share one browser without fighting over a port.

## Demo

<!-- TODO: screenshot of the extension popup showing Connected status and the tool log -->
<!-- TODO: gif of an MCP client calling get_page_snapshot on a logged-in tab -->

What the hub prints when everything is wired up:

```
[livemcp-hub] IPC socket : /tmp/livemcp-hub.sock
[livemcp-hub] WebSocket  : ws://127.0.0.1:17691
[livemcp-hub] Chrome extension connected
[livemcp-hub] Session registered: 3f0c... (1 active)
```

## Quickstart

Requirements: Node.js 18 or newer, Chrome or Chromium, and a Unix-like OS (the hub uses a Unix domain socket).

> `npx livemcp` does not work right now. The `livemcp` name on the npm registry is a security holding package, not this project, and `livemcp-hub` is not published. Build from source.

**1. Build**

```bash
git clone https://github.com/DeepakSilaych/chrome-mcp.git
cd chrome-mcp
npm install && npm run build
```

**2. Load the extension**

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder (not `extension/dist/`). If you skipped the build, `extension.zip` at the repo root and the [latest release](https://github.com/DeepakSilaych/chrome-mcp/releases/latest) contain a prebuilt copy; unzip and load that folder instead.

**3. Start the hub** (once per machine, leave it running)

```bash
npm run hub
```

It prints the WebSocket port and the socket path shown in the demo above.

**4. Point your MCP client at the session binary**

Claude Code (`~/.claude.json`) and Cursor (`.cursor/mcp.json`) take the same JSON. Use the absolute path to your clone.

```json
{
  "mcpServers": {
    "livemcp": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-mcp/server/dist/index.js"]
    }
  }
}
```

**5. Connect Chrome**

Click the LiveMCP icon in the toolbar, then **Connect**. The hub prints `Chrome extension connected`.

**6. Verify**

Ask your AI tool to call `list_tabs`. You should get your open tabs back as JSON, and the popup's tool log should show a `tabs.list` entry.

## How it works

```
┌──────────────────┐   ┌──────────────────┐
│  MCP client A    │   │  MCP client B    │   Claude Code, Cursor, ...
│  (one chat)      │   │  (another chat)  │   one process per chat
└────────┬─────────┘   └────────┬─────────┘
         │ stdio                │ stdio
┌────────▼─────────┐   ┌────────▼─────────┐
│ livemcp session  │   │ livemcp session  │   server/src/index.ts
│ tools/*.ts       │   │ tools/*.ts       │   server/src/hub-client.ts
└────────┬─────────┘   └────────┬─────────┘
         │  Unix socket, newline-delimited JSON
         └──────────┬───────────┘             /tmp/livemcp-hub.sock
             ┌──────▼──────┐
             │ livemcp-hub │                  server/src/hub.ts
             └──────┬──────┘
                    │  WebSocket             ws://127.0.0.1:17691
        ┌───────────▼────────────┐
        │ LiveMCP Bridge (MV3)   │            extension/src/background.ts
        │ handlers/*.ts          │            extension/src/handlers/
        └───────────┬────────────┘
                    │  chrome.tabs / scripting / cookies / debugger
        ┌───────────▼────────────┐
        │ Your Chrome profile    │
        └────────────────────────┘
```

1. Your MCP client spawns `server/dist/index.js` over stdio. `server/src/index.ts` builds an `McpServer`, registers every tool from `server/src/tools/`, and ships a built-in instruction block (tool order, tab targeting, format advice) so the model needs no per-session prompting.
2. Each tool handler calls `bridge.request(action, params)`. The bridge is `server/src/hub-client.ts`: it opens `/tmp/livemcp-hub.sock`, sends `{type:"register", sessionId}`, and then one `{type:"request", id, action, params}` line per tool call. Requests fail fast if the hub is down or the extension is not connected, and time out after 30 s otherwise.
3. `server/src/hub.ts` is the only process that binds a port. It keeps a map of `requestId -> sessionId`, forwards each request to the extension over the WebSocket, and routes the reply back to the session that asked. It pings the extension every 25 s and broadcasts a `status` line to all sessions whenever the extension connects or drops.
4. `extension/src/background.ts` is the service worker. It dials the hub after you click Connect, validates each message against `BRIDGE_ACTIONS` in `shared/src/protocol.ts`, and dispatches to the registry in `extension/src/handlers/index.ts`. It sends a keepalive every 20 s, reconnects with exponential backoff (1 s up to 30 s), and keeps the last 50 calls in `chrome.storage.local` for the popup's tool log.
5. Handlers do the actual work with `chrome.*`: `chromeApi.ts` wraps `tabs`, `scripting.executeScript` and the tab resolver; `debuggerSession.ts` owns `chrome.debugger` for network and console capture.
6. `shared/src/protocol.ts` is the contract both sides import: the action list (`<namespace>.<verb>`), the request and response shapes, and their type guards.

## Security model

Read this before you connect a profile you care about.

**What the extension can reach.** `extension/manifest.json` requests `tabs`, `activeTab`, `scripting`, `cookies`, `debugger`, `storage`, and `host_permissions: ["<all_urls>"]`. On any http(s) page in the profile that means: read and change the DOM, take screenshots, read every cookie Chrome holds for a URL, read `localStorage`, and, with the debugger attached, record request and response bodies and console output. Nothing is filtered by site. If you are logged in, the model is logged in.

**How the pieces connect.**

- The extension is a WebSocket client. It dials `ws://127.0.0.1:<port>` only after you click Connect and keeps retrying until you click Disconnect. It never listens for inbound connections.
- The hub binds `127.0.0.1` only, plus the Unix socket. Nothing in this repo listens on a non-loopback address.
- Sessions are Unix-socket clients of the hub. They bind nothing.

**What stays local.** All of it. The server, hub, and extension make no HTTP calls of their own (there is no `fetch` or `http` import anywhere in `server/src`, `hub/src`, or `extension/src`). The popup's tool log stays in `chrome.storage.local`. The one path out of the machine is the normal MCP one: tool results (page text, screenshots, cookies) go back to your MCP client, which sends them to its model provider.

**What is not protected.**

- There is no authentication on either socket. `shared/src/protocol.ts` carries no token. Any process running as your user can connect to `/tmp/livemcp-hub.sock` and drive the browser. Any process that binds the port before the hub does will receive the extension's connection, and the hub accepts whichever WebSocket client connects, closing the previous one.
- The socket file gets your default umask permissions; the hub sets none explicitly.
- The remote setup below hands full control of your laptop's browser to whatever runs on the VM.

Practical advice: use a dedicated Chrome profile without banking or admin sessions, and click Disconnect when you are done.

## Tools

27 tools. `tab*` means the tool accepts the optional `tabId` / `tabUrl` / `tabTitle` targeting params described below. Tools marked `tabId` need the numeric id only.

| Group | Tool | Params | What it does |
|-------|------|--------|--------------|
| Observe | `get_page_snapshot` | tab* | Screenshot returned as an MCP image, plus interactive elements with CSS selectors (inputs, buttons, up to 30 links), headings, URL, title. Start here on any page. |
| | `get_page_content` | `format?`, `selector?`, tab* | Page content as `aria` (default: compact role, name, selector tree), `text`, `html`, or `markdown` (alias of `text`). `selector` scopes to one subtree. |
| | `get_selected_text` | tab* | Current text selection. |
| | `take_screenshot` | tab* | Visible viewport as a PNG data URL inside JSON text. |
| Tabs | `list_tabs` | | Every tab: id, title, url, active, windowId, index. |
| | `get_active_tab` | | Focused tab in the current window. |
| | `switch_tab` | `tabId` | Focus a tab. |
| | `close_tab` | `tabId` | Close a tab. |
| | `create_tab` | `url?` | Open a tab, optionally at a URL. |
| Navigate | `navigate_to` | `url`, tab* | Navigate and return immediately. |
| | `navigate_and_wait` | `url`, `waitFor?`, `timeout?` (10000 ms), tab* | Navigate, wait for `status=complete`, then optionally for a selector to appear. |
| | `go_back`, `go_forward`, `reload_tab` | tab* | History and reload. |
| Interact | `click_element` | `selector`, tab* | Click the first match. |
| | `click_and_wait` | `selector`, `waitForNavigation?`, `waitFor?`, `timeout?` (5000 ms), tab* | Click, then wait for a navigation or for a selector to appear. |
| | `type_text` | `selector`, `text`, `clear?`, tab* | Append text to an input, textarea, or contentEditable; `clear` empties it first. Fires `input` and `change`. |
| | `fill_form` | `fields[{selector,value}]`, `submit?`, tab* | Set inputs, textareas, selects, checkboxes (`"true"`, `"1"`, `"on"` check; anything else unchecks), radios, contentEditable. `submit` calls `requestSubmit()` on the page's first `<form>`. |
| | `scroll_page` | `direction`, `amount?` (400 px), tab* | Scroll up, down, left, or right. |
| Capture | `start_network_capture`, `stop_network_capture` | `tabId` | Attach `chrome.debugger` and record requests. Stop detaches unless console capture is still on. |
| | `get_captured_requests` | `tabId`, `clearAfter?` | URL, method, status, response headers, body. Base64 bodies are replaced by a `[base64:<length>]` marker. |
| | `start_console_capture`, `stop_console_capture` | `tabId` | Record `console.*` calls and log entries. |
| | `get_console_logs` | `tabId`, `clearAfter?` | Captured entries: text, level, source. |
| Storage | `get_cookies` | `url` | All cookies for the URL via `chrome.cookies.getAll`. |
| | `get_local_storage` | tab* | `localStorage` of the tab's origin as key/value pairs. |

### Tab targeting

| Param | Match |
|-------|-------|
| `tabId` | Exact numeric Chrome tab id. Changes whenever tabs open, so prefer the two below. |
| `tabUrl` | First tab whose URL contains this substring, case-insensitive. |
| `tabTitle` | First tab whose title contains this substring, case-insensitive. |

Resolution order in `extension/src/chromeApi.ts`: `tabId`, then the first tab matching `tabUrl` or `tabTitle`, then the active tab in the current window. A miss on `tabUrl` or `tabTitle` is an error, not a fallback.

```
get_page_snapshot tabUrl="github.com"
fill_form fields=[...] submit=true tabUrl="app.example.com/login"
take_screenshot                       # no spec: active tab
```

## Configuration

| Setting | Where | Default | Purpose |
|---------|-------|---------|---------|
| `LIVEMCP_PORT` | hub env | `17691` | WebSocket port the hub listens on. Also read by `npm run verify-ws`. |
| `LIVEMCP_HUB_SOCK` | hub env and session env | `/tmp/livemcp-hub.sock` | Unix socket path. If you change it, set it for the hub and in the `env` of your MCP client config so sessions find it. |
| Port | extension popup | `17691` | Port the extension dials. Stored as `wsPort` in `chrome.storage.local`; changing it reconnects at once. |

**Port fallback.** If the port is busy, the hub tries the next one (`17692`, `17693`, ...) and prints a warning telling you which port it landed on. Type that port into the popup and reconnect. The extension never auto-detects the port.

**Remote or VM.** Claude Code on a VM, Chrome on your laptop: forward one port and the rest is unchanged.

```bash
# laptop, keep open
ssh -L 17691:localhost:17691 your-vm

# VM
npm run hub
```

The extension dials `127.0.0.1:17691` on the laptop, the tunnel delivers it to the hub on the VM, and every session on the VM shares that connection.

### Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `livemcp-hub is not running. Start it with: livemcp-hub` | The session could not open the Unix socket. Run `npm run hub`, then restart the MCP client. |
| `Chrome extension not connected to hub` | Hub is up, extension is not. Click Connect in the popup and check its port matches what the hub printed. |
| `Bridge request timed out` | No reply within 30 s. The page hung or the extension dropped mid-call. Reconnect and retry. |
| Script injection error on a tab | `chrome://`, the Chrome Web Store, and PDF viewer tabs block `chrome.scripting`. Use a normal https page. |
| Capture fails to attach | `chrome.debugger` allows one client per tab. Close DevTools for that tab or stop the other capture first. |
| Hub prints a port warning at start | `17691` was busy. Set the printed port in the popup and reconnect. |
| `Navigation timed out` from `click_and_wait` | The click did not navigate. Use `waitFor: "<selector>"` instead of `waitForNavigation`. |

## Design decisions and trade-offs

- **Hub plus Unix socket, not one WebSocket server per session.** Only `hub.ts` binds a port. Sessions are tiny socket clients the MCP client spawns and kills per chat, and the hub drops a session's registration the moment its socket closes. That is how N chats share one browser with no port leaks.
- **Extension over CDP or Playwright.** Using `chrome.*` inside your own profile is the whole point, and it costs something: no headless mode, no isolated contexts, no scripting on `chrome://`, Web Store, or PDF tabs, and network/console capture rides on `chrome.debugger`, which conflicts with an open DevTools panel.
- **Compound tools.** Every call crosses stdio, a Unix socket, a WebSocket, and a script injection. `get_page_snapshot`, `navigate_and_wait`, `click_and_wait`, and `fill_form submit` exist to turn two or three round trips into one.
- **`aria` as the default content format.** `handlers/content.ts` walks the DOM to depth 12, skips hidden nodes, and emits one `role "name" [attrs, ref=selector]` line per element, stopping at leaf controls. Selectors come from a fixed heuristic: `#id`, then `[data-testid]`, then `[name]`, then `tag.class`. Pages built without ids or test ids get weaker selectors.
- **Hard timeouts everywhere.** 30 s per request in the session, 10 s default for `navigate_and_wait`, 5 s for `click_and_wait`. Known ceiling: the hub's own `pending` map is never pruned when a session gives up, so a reply that arrives late is dropped but its entry stays.
- **Two screenshot shapes.** `get_page_snapshot` returns a real MCP image item so the model can look at it; `take_screenshot` returns the data URL as text. Use the snapshot when you want the model to see the page.

## Project layout

```
shared/         protocol.ts: BRIDGE_ACTIONS, request/response types, type guards. Imported by both sides.
server/         npm package `livemcp`: MCP session (src/index.ts, src/tools/) and the hub daemon (src/hub.ts).
                esbuild bundles both to dist/index.js and dist/hub.js.
extension/      Chrome MV3 extension: background service worker, handlers/, popup/. Load this folder unpacked.
hub/            Standalone `livemcp-hub` package holding an older WebSocket-only hub. Not in the root
                workspaces and not what `npm run hub` runs. See Limitations.
assets/         Logo and icons.
extension.zip   Prebuilt extension (manifest 1.2.1) for people who do not want to build.
CONTRIBUTING.md Step-by-step guide to adding a tool, and the release process.
CHANGELOG.md    Keep a Changelog format.
```

## Development

```bash
npm install               # npm workspaces: shared, server, extension
npm run build             # server/dist/{index,hub}.js + extension/dist/{background,popup}.js
npm run build:server      # server only
npm run build:extension   # extension only
npm run hub               # node server/dist/hub.js
npm run verify-ws         # probes ws://127.0.0.1:$LIVEMCP_PORT; this displaces a connected extension, so click Connect again after
```

After rebuilding the extension, reload it on `chrome://extensions`. After rebuilding the server, restart the hub and your MCP client.

There is no test suite and no lint script yet. `tsconfig.base.json` is `strict`, but the build runs esbuild only, so type errors do not fail `npm run build`.

Adding a tool touches three files: the action name in `shared/src/protocol.ts`, a handler in `extension/src/handlers/` (registered in `handlers/index.ts`), and a `registerTool` call in `server/src/tools/` (registered in `tools/index.ts`). Spread `tabSpecSchema` from `tools/helpers.ts` into the input schema so the tool gets `tabUrl` and `tabTitle` for free. [CONTRIBUTING.md](CONTRIBUTING.md) walks through it.

## Limitations

- Not installable from npm today: the registry name `livemcp` is a security holding package and `livemcp-hub` is unpublished. Source build only.
- No tests and no CI workflow.
- Chrome and Chromium only: Manifest V3 plus `chrome.*` APIs.
- One browser per hub. The hub keeps a single extension socket; a second extension connecting displaces the first.
- Network and console capture tools take a numeric `tabId` only; `tabUrl` and `tabTitle` are not accepted there.
- `fill_form` with `submit: true` submits the first `<form>` on the page, which may not be the one you filled.
- Windows is not handled: the session-to-hub link is a Unix domain socket with no named-pipe fallback.
- Leftovers: `createBridge` in `server/src/bridge.ts` is unused (only its `Bridge` type is), the `hub/` package duplicates an older hub, and `CONTRIBUTING.md` still uses the pre-rename names `mcp-real-chrome` and `chrome-mcp`.

## Contributing

Issues and pull requests are welcome. Open an issue before a large change so the approach can be discussed first; [CONTRIBUTING.md](CONTRIBUTING.md) has the tool-adding guide and release steps.

## License

[MIT](LICENSE), Deepak Silaych.
