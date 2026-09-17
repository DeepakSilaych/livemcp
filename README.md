<p align="center">
  <img src="assets/logo.png" width="180" alt="LiveMCP logo" />
</p>

<h1 align="center">LiveMCP</h1>

Control your existing Chrome profile through MCP. LiveMCP uses a local or hosted hub and a Manifest V3 extension, preserving the browser's logged-in sessions. Version 2 focuses on efficient agent workflows: stable element references, bounded observations, action results that include state, and sequential batches.

## Build and connect

Requires Node.js 18+ and Chrome/Chromium. Local stdio uses a Unix-like host. For hosted deployment, use the Node 22 Dockerfile and [hosting guide](HOSTING.md).

```sh
npm ci
npm run build
npm run hub
```

Load `extension/` as an unpacked extension from `chrome://extensions`, enter the hub’s full **Server URL** and a **Browser name**, then click **Connect** in its popup. For a local hub use `ws://127.0.0.1:17691`; for a remote reverse proxy use an endpoint such as `wss://bridge.example.com/browser`. New installs leave the URL empty instead of assuming localhost. Existing explicitly saved ports remain compatible. HTTP(S) URLs are converted to WS(S), preserving paths and query parameters. Configure your MCP client:

```json
{
  "mcpServers": {
    "livemcp": {
      "command": "node",
      "args": ["/absolute/path/to/livemcp/server/dist/index.js"]
    }
  }
}
```

Use a source build. The npm registry name has historically been a holding package; this repository is the intended source. No model selection or API credentials are configured by LiveMCP.

## Multiple browsers

One hub supports multiple Chrome/Chromium profiles at the same time. Install the extension in each profile, give it a distinct name (for example “Work Chrome” or “Personal Chrome”), and enter the same hub URL.

Agents call `list_browsers` then `select_browser` with a returned browser ID. Selection applies to that MCP session only and routes **all** its tools, including cookies and captures. Separate agents can select separate browsers. Rediscover tab IDs after changing browsers; numeric tab IDs are not globally unique across profiles.

With one browser, the first browser action selects it automatically. With multiple browsers and no prior selection, the hub asks the agent to select one. A disconnected selected browser never falls back to another. Selection survives a hub reconnection for the lifetime of the agent process; new extension IDs persist in profile-local storage. Legacy extensions get temporary IDs until upgraded. Concurrent requests are correlated to their exact browser connection.

### Remote URLs

The URL must be a WebSocket endpoint, not an ordinary webpage. `https://host/path` becomes `wss://host/path`; `http://host/path` becomes `ws://host/path`. Paths and query parameters are passed through. URL fragments and embedded username/password are rejected. Connect saves edits and reconnects; log/status updates do not overwrite text being edited.

The hub still binds loopback by default. Use a reverse proxy or a trusted tunnel for a remote `wss://` endpoint. `LIVEMCP_HOST` can explicitly change the bind address. Version 2.2 adds authenticated `/mcp` and `/browser` endpoints on one port. Configure a public HTTPS origin and access tokens; the reverse proxy provides TLS. See [HOSTING.md](HOSTING.md) for Docker, reverse proxy, agent URL configuration, account isolation, and local compatibility.

## Upgrade from v1

Rebuild and reload **both** the extension and the MCP server, and restart the hub. This is a major result-contract update:

- `get_page_snapshot` is DOM-only by default. Set `screenshot:true` for an image.
- Observations return `nodes: [{ref,text}]`, document/version metadata, and explicit truncation instead of `interactive` and `headings` arrays.
- `get_page_content` returns an observation or a bounded text envelope, rather than a JSON-encoded string.
- Actions return structured outcomes plus an observation by default. Set `observe:false` when it is unnecessary.
- CSS selectors must be unique. Prefer observed `@refs`.
- Network requests and console logs return paginated envelopes. Response bodies use `get_response_body`.
- URL/title searches reject ambiguous matches; retain a discovered `tabId`.

## Agent workflow

1. Discover the intended tab with `list_tabs`, then retain its ID.
2. Call `get_page_snapshot` for controls, or `get_page_content` with `format:"text"` for prose. Scope to a result region when possible.
3. Act using an observed `ref` in the `selector` argument. Actions return compact state; use it for the next decision.
4. Use `fill_form` for multiple fields, or `run_browser_actions` for a short sequence whose targets are already known.
5. Request a screenshot for visual tasks or ambiguous DOM state. Screenshots target the tab through CDP, including background tabs, without switching focus.
6. Refresh references after navigation or `STALE_REF`. Inspect state after a timeout before repeating an action, especially submission.

### Observations

`get_page_snapshot` and `get_page_content format:"aria"` accept:

| Option | Purpose |
| --- | --- |
| `tabId`, `tabUrl`, `tabTitle` | Pin a known tab or discover a unique match |
| `frameId` | Main frame by default; discover iframe IDs with `list_frames` |
| `selector` | Scope to a unique CSS selector or observed `@ref` |
| `query` | Filter by accessible-name substring |
| `maxChars`, `maxNodes` | Default node-text budget 12,000 characters and 120 nodes; metadata/JSON overhead is additional |
| `offset` | Continue at `nextOffset`; node offset for aria, character offset for text/html |
| `visibleOnly` | True by default; hides elements not rendered or marked aria-hidden |
| `since` | Request changes against a retained observation version |

Open shadow roots are traversed. Names include `aria-labelledby`, labels and ARIA attributes. Observations include selected/expanded/disabled/required states, table cells, prose, and up to 30 select options. Password control values are redacted in observations and fill results. Explicit raw HTML extraction remains raw markup.

Element references persist within the same document/frame. Navigation invalidates references. A removed node can be rebound only to one replacement with a unique id/data-testid/name anchor and matching tag, type, and accessible name; ambiguous or changed identities remain stale. Eight bounded observation baselines are retained per document. A delta has changed `nodes`, `removed` refs, and an optional new `order`. If the baseline is unavailable or the scope/options differ, a full observation with `reset:true` is returned. After client context compaction, request a full observation. Deltas describe the bounded observed region, not every offscreen part of a page. DOM equality does not imply that canvas/video pixels are unchanged.

### Actions and batches

`click_element`, `type_text`, `fill_form`, `click_and_wait` and `scroll_page` accept `observe`, `observationSelector` and `maxChars`. `navigate_and_wait` also accepts these options. Use `waitUntil:"domcontentloaded"` to proceed when the new document is usable before all resources complete; the compatibility default is `complete`. `waitFor` waits for a visible target under the same deadline.

Example (replace example refs with actual observed values):

```json
{
  "tabId": 42,
  "steps": [
    {"action":"type","selector":"@document:1","text":"invoice","clear":true},
    {"action":"clickAndWait","selector":"@document:2","waitFor":"#results"}
  ],
  "observationSelector":"#results"
}
```

Pass this to `run_browser_actions`, `press_key`, `select_option`. Supported steps are `click`, `type`, `fill`, `scroll`, `clickAndWait`, `navigate`, `wait`, `waitFor`, `pressKey`, `selectOption`, `observe`, and `content`. Batches contain 1–20 steps with a shared execution budget up to 60 seconds (default 60 seconds). They stop on error, report completed steps, and do not roll back. Do not batch through an unknown decision or reuse old document references after navigation. This is a typed action runner with persistent page references, not an arbitrary JavaScript REPL.

### Carrier workflows (v2.3)

- `click_element` and `click_and_wait` default to trusted CDP mouse input. The target is scrolled into view and checked for overlays before clicking. `mode:"dom"` keeps synthetic input available explicitly.
- `press_key` sends Enter, arrows, Tab, Escape, editing keys or a character. Optional `selector` focuses a known control first. Modifiers use a bitmask: Alt=1, Control=2, Meta=4, Shift=8.
- `type_text mode:"trusted"` inserts text through CDP. `inputMethod:"keys"` sends individual key events. `allowReadonly:true` permits key input to custom readonly pickers without removing their readonly attribute; verify whether the component accepted it. This does not make ordinary readonly inputs editable.
- `select_option` picks exact text inside an open, scoped dropdown and scrolls the option into view. Hidden items are rejected. For a native select, target it with `selector` and supply `text` or `value`.
- `wait_for_text`, `wait_for_url`, and `wait_for_network_idle` support up to 60 seconds. Batch `wait` supports a visible selector; batch `waitFor` supports `kind: "selector" | "text" | "url" | "networkIdle"`. The batch and its steps share one deadline. Set the consuming client's request timeout above 65 seconds for long waits. Long polling may prevent network idle; requests already underway before debugger attachment may be unobserved. Prefer a result-specific text/URL condition.
- `read_element_state` returns bounded values, selected/checked/readonly state, rendered visibility and selected attributes, including hidden inputs. Password values are redacted. It replaces small state-reading scripts; it does not expose arbitrary `evaluate_js` or call framework component methods. Arbitrary JavaScript cannot be guaranteed read-only.
- Action observations default to **1,500 node-text characters and 30 nodes**, plus metadata. `observe:false` omits them. Set `since` to a retained matching action-observation version for a delta; request a full baseline after context compaction. No automatic baseline is shared between agents.
- `get_tab_health` bypasses the tab queue to report responsiveness, active action, elapsed deadline, and debugger status. `recoverDebugger:true` reattaches only when the queue is idle and preserves enabled capture modes. It never cancels/replays a potentially completed mutation. `BRIDGE_TIMEOUT`, `QUEUE_TIMEOUT`, and `TAB_UNRESPONSIVE` distinguish transport, queue and page failures.

Trusted pointer/keyboard input currently supports the **main frame**. Frame-local synthetic click/type remains available with `mode:"dom"`; frame observations are unchanged. Debugger attachment can fail when another debugger or browser policy owns the target. CDP screenshots capture the tab viewport, not a selected iframe in isolation.

These paths are validated in Chromium fixtures, including `isTrusted`, readonly key handlers, offscreen dropdown choices, concurrent background screenshots and health probes during waits. No carrier-specific success rate or 3–5× end-to-end token reduction is claimed.

### Recoverable errors and worker scheduling

Batch `observe` and `content` steps accept **500–6000** characters per step. Their limits differ from standalone reads. Validate against `tools/list` before dispatch; do not copy a standalone observation budget into a batch. Invalid MCP arguments are rejected before any browser command is sent.

Selectors are native CSS or observed `@refs`. Playwright `:has-text()`, `text=`, and locator expressions are unsupported. Use a scoped snapshot and the returned ref. Batch and click-and-wait selector syntax is checked before mutation, including selectors for later steps and waits. Preflight failures report `phase: "preflight"` and `actionMayHaveOccurred: false`; ref existence is checked at execution time because earlier steps can change the document.

Wrappers must preserve MCP `isError` and its text/JSON content instead of replacing them with exception class names. Invalid arguments or a preflight rejection should allow corrected calls in the same session. A failure after completed batch steps must preserve those results: never replay the whole batch automatically. Disconnects or timeouts during a mutating action still require state inspection; a validation failure alone is not evidence that background tabs or a carrier login failed.

`fill_form` validates targets before mutation, uses native input setters, checks form ownership, and reports partial outcomes and validation messages. `submitted:true` means submission was requested; verify the resulting application state to confirm completion. Clicks default to trusted CDP mouse events. `mode:"dom"` explicitly uses synthetic clicks. `fill_form` and default `type_text` still use native setters; use `type_text mode:"trusted"` for trusted browser input.

### Other tools

- Browsers: `list_browsers`, `select_browser`.
- Tabs: `list_tabs`, `get_active_tab`, `switch_tab`, `close_tab`, `create_tab`, `list_frames`.
- Content: `get_page_snapshot`, `get_page_content`, `get_selected_text`, `take_screenshot`.
- Navigation: `navigate_to`, `navigate_and_wait`, `go_back`, `go_forward`, `reload_tab`.
- Interaction: `click_element`, `click_and_wait`, `type_text`, `fill_form`, `scroll_page`, `run_browser_actions`, `press_key`, `select_option`.
- Network: `start_network_capture`, `stop_network_capture`, `get_captured_requests`, `get_response_body`.
- Console: `start_console_capture`, `stop_console_capture`, `get_console_logs`.
- Readiness and health: `wait_for_text`, `wait_for_url`, `wait_for_network_idle`, `get_tab_health`, `read_element_state`.
- Storage: `get_cookies`, `get_local_storage`.

Network/console buffers retain at most 500 records each per captured tab. Reads support `limit`, `offset`, `clearAfter`, and a URL or level filter, and report evictions/truncation. Record text is bounded, and read pages have a 12,000-character content budget. Stopping capture preserves buffered metadata until the tab closes or a new capture starts. Response bodies are fetched on demand while debugger access is available; large/non-text bodies may be truncated or omitted.

## Architecture and recovery

```text
Local agent → stdio → Unix socket ─┐
                                  ├→ one hub → /browser → extension → Chrome APIs
Remote agent → HTTPS /mcp ─────────┘
```

The hub is `server/src/hub.ts`; the older standalone `hub/` package is not used. Work is serialized per tab, with independent tabs able to progress concurrently. CDP screenshots target individual tabs; different tabs can capture concurrently. Snapshot screenshot checks reject a changed tab/document/observed DOM revision; they are not a guarantee of pixel-level atomicity.

Hub pending requests expire and are removed on session/extension disconnect. Session clients reconnect automatically without replaying actions. A queued operation whose deadline expired is rejected before execution. In-flight browser actions are not rolled back on disconnect; their outcome may be unknown.

The popup log retains 50 recent calls, including execution time and serialized response bytes. These measure bridge/extension behavior, not model inference latency.

| Setting | Default |
| --- | --- |
| `LIVEMCP_HOST` (hub bind address) | `127.0.0.1` |
| `LIVEMCP_PORT` (hub) | `17691` |
| `LIVEMCP_HUB_SOCK` (hub and client) | `/tmp/livemcp-hub.sock` |
| `LIVEMCP_PUBLIC_URL` | Unset; set to the hosted HTTPS origin |
| `LIVEMCP_TOKEN` / `LIVEMCP_ACCOUNTS` | Unset; required for hosted access |
| `LIVEMCP_DISABLE_IPC` | Unset; use `1` for HTTP-only hosting |
| Extension popup Server URL | Empty on a new install; saved legacy ports are preserved |

If a port is occupied, the hub fails explicitly; free it or configure `LIVEMCP_PORT`. Restricted browser pages and some frames block script injection. Debugger capture can conflict with DevTools or another debugger. Closed shadow roots remain inaccessible. Multiple browser profiles can share one hub, with selection per agent session. Multi-call workflows are not exclusive leases on tabs; another user/session can change a tab between calls.

## Development and validation

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run build
npm test
```

Tests exercise real DOM behavior, mocked Chrome API races, a real hub disconnect, and the built extension in a fresh Chrome profile over WebSocket. `LIVEMCP_CHROME` optionally overrides the executable for DOM tests. The extension test uses Playwright's Chromium channel.

See [OPTIMIZATIONS.md](OPTIMIZATIONS.md) for the implementation summary, measured context example, and validation limits. End-to-end task speed must be benchmarked in the consuming Astra client.

## Security model

The extension uses `tabs`, `activeTab`, `scripting`, `cookies`, `debugger`, `storage`, and `<all_urls>` access. It can interact with logged-in pages, read storage/cookies and page content, and inspect network/console data. Tool results are sent to the consuming MCP client and its model provider.

The hub binds loopback by default (or `LIVEMCP_HOST`) and a Unix socket. Unauthenticated mode is restricted to local binding; trusted local processes can drive the browser. Hosted access requires bearer tokens, and each account sees only its own browsers. Unix sockets use mode `0600`. See [hosting and authentication](HOSTING.md). A forwarded remote connection grants the remote client browser access. Use a profile appropriate for that access and disconnect when finished. Page content is untrusted data, not permission to expand the user's task.

## License

MIT.
