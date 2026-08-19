import net, { type Socket } from "node:net";

import type {
  DesktopNotification,
  DesktopShell,
} from "@deepseek-ai/dsh-desktop-shell";

const CONNECT_TIMEOUT_MS = 2_000;
const MAX_QUEUE_SIZE = 64;

export class BridgeUnreachableError extends Error {
  override name = "BridgeUnreachableError";

  constructor(message = "The DeepSeek Harness desktop bridge is unreachable") {
    super(message);
  }
}

type BridgeFrame =
  | { type: "notify"; title: string; body?: string }
  | { type: "revealPath"; path: string };

interface BridgeConfig {
  port: number;
  token: string;
}

/**
 * A dependency-free TCP provider for the loopback bridge implemented by the
 * Tauri shell. Missing bridge environment variables intentionally produce a
 * no-op provider so `dsh --profile desktop` remains usable without the GUI.
 */
export function createDesktopShellTcpProvider(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopShell {
  const config = parseConfig(environment);
  if (!config) {
    return {
      notify: async () => undefined,
      revealPath: async () => undefined,
    };
  }

  const bridge = new LoopbackBridge(config);
  return {
    notify: (notification) => bridge.send({ type: "notify", ...notification }),
    revealPath: (path) => bridge.send({ type: "revealPath", path }),
  };
}

class LoopbackBridge {
  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private pending = Promise.resolve();
  private queueSize = 0;
  private readonly config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  send(frame: BridgeFrame): Promise<void> {
    if (this.queueSize >= MAX_QUEUE_SIZE) {
      return Promise.reject(
        new BridgeUnreachableError("The desktop bridge queue is full"),
      );
    }

    this.queueSize += 1;
    const result = this.pending.then(async () => {
      try {
        const socket = await this.getSocket();
        await writeWithTimeout(socket, `${JSON.stringify(frame)}\n`);
      } finally {
        this.queueSize -= 1;
      }
    });

    // Keep a failed request from poisoning the serial queue, while returning
    // the original rejection to the caller.
    this.pending = result.catch(() => undefined);
    return result;
  }

  private getSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: this.config.port,
      });
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new BridgeUnreachableError(errorMessage(error)));
      };

      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        writeWithTimeout(
          socket,
          `${JSON.stringify({
            type: "hello",
            token: this.config.token,
            pid: process.pid,
          })}\n`,
        )
          .then(() => {
            if (settled) return;
            settled = true;
            this.socket = socket;
            resolve(socket);
          })
          .catch(fail);
      });
      socket.once("timeout", () => fail(new Error("connection timed out")));
      socket.once("error", fail);
      socket.once("close", () => {
        if (this.socket === socket) this.socket = undefined;
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }
}

function parseConfig(environment: NodeJS.ProcessEnv): BridgeConfig | undefined {
  const token = environment.DSH_DESKTOP_BRIDGE_TOKEN;
  const port = Number(environment.DSH_DESKTOP_BRIDGE_PORT);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { port, token };
}

function writeWithTimeout(socket: Socket, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new BridgeUnreachableError("desktop bridge write timed out"));
    }, CONNECT_TIMEOUT_MS);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      if (error) reject(new BridgeUnreachableError(errorMessage(error)));
      else resolve();
    };
    const onError = (error: unknown) => finish(error);
    socket.once("error", onError);
    socket.write(payload, () => finish());
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
