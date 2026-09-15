# Changelog

## [2.0.0] – 2026-09-15

Browser workflow overhaul: persistent refs, bounded/delta observations, action-plus-state results, sequential batches, frame/shadow support, correct screenshot images, race-free waits, form ownership, bounded capture and transport recovery. Result contracts changed; see README migration notes.

## [1.3.0] – 2026-06-19

### Added
- **`format: "aria"` for `get_page_content`** — returns a compact accessibility tree (roles, names, CSS selectors) instead of raw HTML. 10–20× smaller than HTML, structured exactly how LLMs think. Now the default format.
  ```
  - heading "Sign in" [level=1]
  - textbox "Email" [type=email, ref=#email]
  - textbox "Password" [type=password, ref=#password]
  - button "Sign in" [ref=button[type=submit]]
  - link "Forgot password?" [href=/reset, ref=a.forgot]
  ```
- **`selector` param on `get_page_content`** — scope extraction to any CSS subtree instead of the whole page. E.g. `selector=".search-results"`, `selector="#main"`, `selector="table"`. Works with all formats including `"aria"`.
- **Expanded system prompt / agent instructions** — detailed guidance baked into the MCP server on tool sequencing, tab targeting, format selection, and error recovery. Reduces wrong tool calls without needing per-session prompting.

### Changed
- `get_page_content` default format changed from `"text"` to `"aria"`.

---

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.1] – 2026-06-17

### Added
- **Stable tab targeting** — every tool now accepts `tabUrl` and `tabTitle` string params as alternatives to the numeric `tabId`. The extension finds the first tab whose URL or title contains the given substring (case-insensitive). Numeric IDs change whenever new tabs are opened; URL/title matching is robust across an entire session.
  - Example: `get_page_snapshot tabUrl="github.com"` always hits the GitHub tab, regardless of which tab has focus.

### Changed
- `take_screenshot` no longer requires `windowId`; it now follows the same `tabUrl`/`tabTitle`/`tabId` convention as all other tools.
- Default tab resolution falls back to the currently active tab when no specifier is given — existing usage is fully backwards compatible.

---

## [1.2.0] – 2026-06-17

### Added
- **`get_page_snapshot`** — compound tool that returns a visual screenshot **and** structured page data (interactive elements with CSS selectors, headings, URL, title) in a single round-trip. Eliminates the need to call `take_screenshot` and `get_page_content` separately. The screenshot is returned as an MCP image content item so the LLM can see it directly.
- **`navigate_and_wait`** — navigate to a URL and block until the page reaches `status=complete`, with an optional CSS selector to wait for after load. Replaces the manual `navigate_to` + poll loop.
- **`click_and_wait`** — click an element and wait for either a full page navigation (`waitForNavigation: true`) or a specific DOM element to appear (`waitFor: "<selector>"`). Combines two round-trips into one.
- **`fill_form` upgrade** — now handles the full range of HTML form controls:
  - `<select>` dropdowns (set by value)
  - `<input type="checkbox">` (pass `"true"` / `"false"`)
  - `<input type="radio">` (sets `checked = true`)
  - `contentEditable` elements
  - New `submit: true` param to submit the form in the same call

### Changed
- Extension version bumped to 1.1.0 → included in hub architecture release.
- Protocol gains three new bridge actions: `page.snapshot`, `navigate.andWait`, `interact.clickAndWait`.

---

## [1.1.1] – 2026-06-16

### Fixed
- `npx mcp-real-chrome` failed because npm only auto-runs a binary that matches the package name. Added `mcp-real-chrome` and `mcp-real-chrome-hub` as explicit bin aliases alongside `chrome-mcp` / `chrome-mcp-hub`.

---

## [1.1.0] – 2026-06-16

### Added
- **Hub architecture** — split the server into two binaries so multiple Claude sessions can share a single Chrome connection with no port conflicts and no port leak.
  - `chrome-mcp-hub` (`npx mcp-real-chrome-hub`) — always-on daemon that holds the WebSocket on port 17691 (auto-increments on collision) and multiplexes requests over a Unix socket at `/tmp/chrome-mcp-hub.sock`.
  - `chrome-mcp` (`npx mcp-real-chrome`) — lightweight MCP session process. Connects to the hub via Unix socket; cleans up automatically when the Claude chat ends. Multiple sessions can run simultaneously.
- **Port auto-increment** — if port 17691 is busy, the hub tries 17692, 17693 … and prints instructions to update the extension popup.
- **Remote / VM support** — documented SSH tunnel workflow: `ssh -L 17691:localhost:17691 dev-training-vm` lets your laptop's Chrome extension reach a hub running on a remote VM.
- Extension version bumped to 1.1.0.

### Changed
- `Bridge` type no longer carries a `port` field — sessions have no port.
- esbuild bundle script builds both `dist/index.js` and `dist/hub.js` from a shared config.

### Fixed
- Hub binary had a double shebang (`#!/usr/bin/env node` in source + banner from esbuild) causing `SyntaxError` on startup. Removed the shebang from `hub.ts` source; esbuild injects it via the `banner` option.

---

## [1.0.0] – 2026-06-14

### Added
- Initial release.
- Chrome extension (Manifest V3) that connects to a local WebSocket server and exposes full `chrome.*` API access.
- MCP server exposing tools: `list_tabs`, `get_active_tab`, `switch_tab`, `close_tab`, `create_tab`, `get_page_content`, `get_selected_text`, `take_screenshot`, `navigate_to`, `go_back`, `go_forward`, `reload_tab`, `start_network_capture`, `stop_network_capture`, `get_captured_requests`, `start_console_capture`, `stop_console_capture`, `get_console_logs`, `click_element`, `type_text`, `fill_form`, `scroll_page`, `get_cookies`, `get_local_storage`.
- npm package `mcp-real-chrome` with bin entries `chrome-mcp` and `chrome-mcp-hub`.
