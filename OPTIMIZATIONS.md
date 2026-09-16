# Browser efficiency changes

## Implemented

- Real image blocks for both screenshot tools, optional images in snapshots, target/identity checks and capture throttling.
- Persistent document/frame-scoped references, unique CSS resolution, open shadow roots and iframe discovery/targeting.
- Unified bounded observations, accessible labels and useful control states, explicit pagination/truncation, and versioned deltas with reset handling.
- Scoped state attached to actions; typed sequential batches with partial completion and no automatic action replay.
- Navigation listeners armed before actions, one timeout budget, visible-target waits, and optional DOM-ready navigation.
- Form preflight, owning-form selection, native setters, password redaction, and validation/partial outcomes.
- Bounded network/console buffers and read pages; lazy response-body retrieval.
- Per-tab request ordering, queue expiry, hub pending cleanup, fast failure on disconnect and automatic client reconnection.
- Concise workflow instructions, response byte/timing telemetry, real type checks, a lockfile and browser/transport regression tests.

## Measurement

A repeatable 120-button fixture produced a full observation of **8,394 bytes** and an unchanged delta of **240 bytes**, a **97% reduction in serialized response size**. This compares two supported observation modes in this implementation. It is not an old-versus-new Astra task benchmark or a claim about token counts or latency on arbitrary sites.

The batch extension test fills an input, clicks a control and obtains final state through one bridge request. An unbatched fill/read/click/read sequence would require separate requests. Actual model round-trip savings depend on the client and task.

## Validation scope

Validated locally: **24 tests passed**, TypeScript checks and production builds passed, and `npm ci --ignore-scripts` completed with zero reported dependency vulnerabilities. The test run included a fresh Chromium profile loading the built extension.

Run `npm run typecheck`, `npm run build`, and `npm test`. The suite covers DOM behavior, tab ambiguity, waits/races, screenshot image shape and targeting, stale references, native setters, form ownership, scope/paging/deltas, capture limits, hub disconnect cleanup, and the built extension in isolated Chromium.

Astra account-level completion rate, reasoning time, tool-call count and token cost have not been benchmarked. No user's logged-in profile was exercised. This branch does not add an arbitrary JavaScript REPL, closed-shadow-root access, trusted mouse/keyboard input, exclusive cross-call tab leases, or pixel-level atomic snapshots. Those are separate runtime capabilities with additional compatibility requirements.

## Adoption

This is a v2 result-contract change. Reload the rebuilt extension, restart the rebuilt hub and restart the MCP client together. See README for changed result shapes. Keep the old checkout available if a consuming client is hard-coded to the v1 schemas.
