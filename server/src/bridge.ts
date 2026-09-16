import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { BridgeAction, BridgeRequest, BridgeResponse } from "@livemcp/shared";
import { isBridgeResponse } from "@livemcp/shared";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type Bridge = {
  listBrowsers?: () => Promise<unknown>;
  selectBrowser?: (browserId: string) => Promise<unknown>;
  isConnected: () => boolean;
  request: (action: BridgeAction, params: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
};

export function createBridge(port: number, requestTimeoutMs = 30_000): Bridge {
  const pending = new Map<string, Pending>();
  let client: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[livemcp] Port ${port} already in use. Kill the other process or set LIVEMCP_PORT to a different port.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`[livemcp] WebSocket server error: ${err.message}\n`);
  });

  wss.on("connection", (ws) => {
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    if (pingTimer) clearInterval(pingTimer);
    client = ws;
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object" && "keepalive" in (parsed as Record<string, unknown>)) return;
      if (!isBridgeResponse(parsed)) return;
      const res = parsed as BridgeResponse;
      const slot = pending.get(res.id);
      if (!slot) return;
      clearTimeout(slot.timer);
      pending.delete(res.id);
      if (res.error !== undefined) {
        slot.reject(new Error(res.error));
      } else {
        slot.resolve(res.result);
      }
    });
    ws.on("close", () => {
      if (client === ws) {
        client = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
      }
    });
    ws.on("error", () => {
      if (client === ws) {
        client = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
      }
    });
  });

  const isConnected = () => client !== null && client.readyState === WebSocket.OPEN;

  const request = (action: BridgeAction, params: Record<string, unknown> = {}) => {
    if (!isConnected()) {
      return Promise.reject(new Error("Chrome extension not connected to bridge"));
    }
    const id = randomUUID();
    const body: BridgeRequest = { id, action, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Bridge request timed out"));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      client!.send(JSON.stringify(body));
    });
  };

  const close = async () => {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error("Bridge closed"));
    }
    pending.clear();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { isConnected, request, close };
}
