import { Bash, InMemoryFs } from "just-bash/browser";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PlatformKind = "native" | "cloudflare";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type PlatformRequest =
  | { type: "sqlExec"; statement: string; params: JsonValue[] }
  | { type: "sqlQuery"; statement: string; params: JsonValue[] }
  | { type: "webSocketSend"; connectionId: string; payloadJson: string }
  | { type: "webSocketBroadcast"; payloadJson: string }
  | {
      type: "processSpawn";
      sandboxName: string;
      argv: string[];
      cwd: string | null;
      env: [string, string][];
    }
  | { type: "processWriteStdin"; processId: string; data: string }
  | { type: "processKill"; processId: string; signal: number | null }
  | {
      type: "bashExec";
      command: string;
      cwd: string | null;
      env: [string, string][];
      timeoutMs: number | null;
    }
  | {
      type: "httpRequest";
      method: string;
      url: string;
      headers: [string, string][];
      body: string | null;
    }
  | { type: "envGet"; key: string }
  | { type: "clockNowUnixSeconds" }
  | { type: "randomU64" }
  | {
      type: "log";
      level: LogLevel;
      message: string;
      fields: JsonValue;
    };

export type PlatformResponse =
  | { type: "ack" }
  | { type: "sql"; rows: JsonValue[]; rowsWritten: number }
  | { type: "processSpawned"; processId: string }
  | {
      type: "processOutput";
      stdout: string;
      stderr: string;
      done: boolean;
      exitCode: number | null;
    }
  | {
      type: "bashExecResult";
      stdout: string;
      stderr: string;
      exitCode: number;
    }
  | {
      type: "httpResponse";
      status: number;
      headers: [string, string][];
      body: string;
    }
  | { type: "envValue"; value: string | null }
  | { type: "clockNowUnixSeconds"; now: number }
  | { type: "randomU64"; value: string };

export interface Platform {
  readonly kind: PlatformKind;
  call(request: PlatformRequest): Promise<PlatformResponse>;
}

type DurableSocket = {
  send(payload: string): void;
};

type DurableStateLike = {
  storage: {
    sql: {
      exec(statement: string, ...bindings: unknown[]): {
        toArray(): JsonValue[];
        rowsWritten: number;
      };
    };
  };
  getWebSockets(): DurableSocket[];
};

export class CloudflarePlatform implements Platform {
  readonly kind: PlatformKind = "cloudflare";
  private readonly modelHttpProxyUrl: string | null;
  private bash: Bash | null = null;

  constructor(
    private readonly state: DurableStateLike,
    private readonly socketById: (id: string) => DurableSocket | null,
    private readonly sandboxBaseUrl: string,
    private readonly envValues: Record<string, string | undefined>,
  ) {
    this.modelHttpProxyUrl = envValues.MODEL_HTTP_PROXY_URL ?? null;
  }

  async call(request: PlatformRequest): Promise<PlatformResponse> {
    switch (request.type) {
      case "sqlExec": {
        const cursor = this.state.storage.sql.exec(
          request.statement,
          ...request.params,
        );
        return { type: "sql", rows: [], rowsWritten: cursor.rowsWritten };
      }
      case "sqlQuery": {
        const cursor = this.state.storage.sql.exec(
          request.statement,
          ...request.params,
        );
        return {
          type: "sql",
          rows: cursor.toArray(),
          rowsWritten: cursor.rowsWritten,
        };
      }
      case "webSocketSend": {
        const socket = this.socketById(request.connectionId);
        if (socket) {
          socket.send(request.payloadJson);
        }
        return { type: "ack" };
      }
      case "webSocketBroadcast": {
        for (const socket of this.state.getWebSockets()) {
          socket.send(request.payloadJson);
        }
        return { type: "ack" };
      }
      case "processSpawn": {
        const response = await fetch(`${this.sandboxBaseUrl}/spawn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sandboxName: request.sandboxName,
            argv: request.argv,
            cwd: request.cwd,
            env: request.env,
          }),
        });
        const body = (await response.json()) as { processId: string };
        return { type: "processSpawned", processId: body.processId };
      }
      case "processWriteStdin": {
        await fetch(`${this.sandboxBaseUrl}/stdin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        return { type: "ack" };
      }
      case "processKill": {
        await fetch(`${this.sandboxBaseUrl}/kill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        return { type: "ack" };
      }
      case "bashExec": {
        const bash = this.getBash();
        const execPromise = bash.exec(request.command, {
          cwd: request.cwd ?? undefined,
          env: Object.fromEntries(request.env),
        });
        const timeoutMs = request.timeoutMs ?? 0;
        if (timeoutMs > 0) {
          const raced = await Promise.race([
            execPromise.then((finished) => ({
              timeout: false as const,
              finished,
            })),
            new Promise<{ timeout: true }>((resolve) => {
              setTimeout(() => resolve({ timeout: true }), timeoutMs);
            }),
          ]);
          if (raced.timeout) {
            return {
              type: "bashExecResult",
              stdout: "",
              stderr: `command timed out after ${timeoutMs}ms`,
              exitCode: 124,
            };
          }
          return {
            type: "bashExecResult",
            stdout: raced.finished.stdout,
            stderr: raced.finished.stderr,
            exitCode: raced.finished.exitCode,
          };
        }
        const finished = await execPromise;
        return {
          type: "bashExecResult",
          stdout: finished.stdout,
          stderr: finished.stderr,
          exitCode: finished.exitCode,
        };
      }
      case "httpRequest": {
        if (this.modelHttpProxyUrl) {
          const response = await fetch(this.modelHttpProxyUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: request.body,
            }),
          });
          const proxied = (await response.json()) as {
            status: number;
            headers: [string, string][];
            body: string;
          };
          return {
            type: "httpResponse",
            status: proxied.status,
            headers: proxied.headers,
            body: proxied.body,
          };
        }
        const response = await fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body ?? undefined,
        });
        const headers = [...response.headers.entries()].map(
          ([key, value]) => [key, value] as [string, string],
        );
        return {
          type: "httpResponse",
          status: response.status,
          headers,
          body: await response.text(),
        };
      }
      case "envGet":
        return {
          type: "envValue",
          value: this.envValues[request.key] ?? null,
        };
      case "clockNowUnixSeconds":
        return { type: "clockNowUnixSeconds", now: Math.floor(Date.now() / 1000) };
      case "randomU64": {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const value = bytes.reduce(
          (acc, byte) => (acc << 8n) | BigInt(byte),
          0n,
        );
        return { type: "randomU64", value: value.toString() };
      }
      case "log": {
        const fields =
          request.fields && typeof request.fields === "object"
            ? request.fields
            : {};
        console.log(JSON.stringify({ level: request.level, message: request.message, fields }));
        return { type: "ack" };
      }
    }
  }

  private getBash(): Bash {
    if (!this.bash) {
      this.bash = new Bash({
        fs: new InMemoryFs(),
        cwd: "/",
        maxCallDepth: 100,
        maxCommandCount: 200,
        maxLoopIterations: 100_000,
      });
    }
    return this.bash;
  }
}

export function createWasmPlatformImports(platform: Platform): {
  codexPlatformCall(requestJson: string): Promise<string>;
} {
  return {
    async codexPlatformCall(requestJson: string): Promise<string> {
      const request = JSON.parse(requestJson) as PlatformRequest;
      const response = await platform.call(request);
      return JSON.stringify(response);
    },
  };
}
