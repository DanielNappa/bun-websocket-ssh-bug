import { Buffer } from "node:buffer";
import process from "node:process";
import WebSocket from "ws";
import {
  BaseStream,
  ObjectDisposedError,
  SshAlgorithms,
  SshClientSession,
  SshDisconnectReason,
  SshProtocolExtensionNames,
  SshSessionConfiguration,
  type Stream,
} from "@microsoft/dev-tunnels-ssh";
import { PortForwardingService } from "@microsoft/dev-tunnels-ssh-tcp";
import { ChildProcess, type StdioOptions } from "node:child_process";
import type { ErrorEvent } from "undici/types";

interface SpawnOptions {
  stdio: StdioOptions | undefined;
  env?: Record<string, string | undefined>;
  cwd?: string;
  onExit?: (
    exitCode: number | null,
    signalCode:
      | NodeJS.Signals
      | number
      | string
      | null
      | undefined,
  ) => void;
}
const sessionMap: Map<string, SshClientSession> = new Map();
function closeSessions(sessions?: string[]): void {
  Array.from(sessionMap.entries()).forEach(([key, session]) => {
    if (sessions && !sessions.includes(key)) {
      return;
    }
    void session.close(SshDisconnectReason.byApplication);
    sessionMap.delete(key);
  });
}
async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<Bun.Subprocess | ChildProcess> {
  const runtime = navigator.userAgent;
  if (runtime.startsWith("Bun")) {
    try {
      const sshBunCommand = Bun.spawn({
        cmd: [command, ...args],
        stdio: ["inherit", "inherit", "inherit"],
        env: options.env,
        cwd: options.cwd,
      });
      void sshBunCommand.exited.then(() => {
        options.onExit?.(
          sshBunCommand.exitCode,
          sshBunCommand.signalCode ?? null,
        );
      }).catch(() => {
        options.onExit?.(
          sshBunCommand.exitCode,
          sshBunCommand.signalCode ?? null,
        );
      });
      return sshBunCommand;
    } catch (error) {
      console.error("Failed to spawn Bun process:", error);
      throw error;
    }
  } else {
    // Node.js - use standard spawn
    const { spawn } = await import("node:child_process");
    const sshProcess = spawn(command, args, options);
    sshProcess.on("exit", (code, signal) => {
      options.onExit?.(code, signal);
    });
    return sshProcess;
  }
}

class connectionClientStream extends BaseStream {
  public constructor(private readonly connection: WebSocket) {
    super();
    connection.on(
      "message",
      (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          const buffer: Buffer<ArrayBufferLike> = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          console.log(
            `[WebSocket] Received message, type: ${typeof data}, size: ${
              data instanceof ArrayBuffer
                ? data.byteLength
                : Object.keys(data).length || data?.length || "unknown"
            }`,
          );
          this.onData(buffer);
        }
      },
    );
    connection.on("close", (code?: number, reason?: string) => {
      if (!code) {
        console.log(
          `[WebSocket] Connection closed, code: ${code}, reason: ${reason}`,
        );
        this.onEnd();
      } else {
        const error = new Error(reason) as Error & { code?: number };
        error.code = code ?? 1011;
        this.onError(error);
      }
    });
  }

  public write(data: Buffer): Promise<void> {
    if (this.disposed) {
      throw new ObjectDisposedError(this);
    }
    if (!data) {
      throw new TypeError("Data is required.");
    }

    console.log(`[WebSocket] Sending data of size ${data.length}`);
    this.connection.send(data);
    return Promise.resolve();
  }

  public close(error?: Error): Promise<void> {
    if (this.disposed) {
      throw new ObjectDisposedError(this);
    }

    if (!error) {
      console.log("[WebSocket] Closing connection normally");
      this.connection.close(1000);
    } else {
      console.log(
        `[WebSocket] Closing connection with error: ${error.message}`,
      );
      this.connection.close(
        (error as Error & { code?: number }).code ?? 1011,
        error.message,
      );
    }
    this.disposed = true;
    this.closedEmitter.fire({ error });
    this.onError(error || new Error("Stream closed."));
    return Promise.resolve();
  }

  public override dispose(): void {
    if (!this.disposed) {
      this.connection.close();
    }
    super.dispose();
  }
}

const runtime = typeof Bun !== "undefined" ? "Bun" : "Node.js";
console.log(`[Client] Attempting to connect using ${runtime}...`);

async function testSSH() {
  const serverURI = "ws://localhost:8080";
  const sessionMap = new Map();

  // close the opened session if exists
  const isContinue = new Promise((res) => {
    const session = sessionMap.get(serverURI);
    if (session) {
      void session
        .close(SshDisconnectReason.byApplication)
        .finally(() => res(true));
    } else {
      res(true);
    }
  });
  await isContinue;
  const config = new SshSessionConfiguration();

  config.keyExchangeAlgorithms.splice(0, config.keyExchangeAlgorithms.length);
  config.publicKeyAlgorithms.splice(0, config.publicKeyAlgorithms.length);

  config.keyExchangeAlgorithms.push(
    SshAlgorithms.keyExchange.ecdhNistp256Sha256!,
  );
  config.keyExchangeAlgorithms.push(
    SshAlgorithms.keyExchange.ecdhNistp521Sha512!,
  );
  config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.ecdsaSha2Nistp521!);
  config.publicKeyAlgorithms.push(SshAlgorithms.publicKey.rsa2048!);
  config.encryptionAlgorithms.push(SshAlgorithms.encryption.aes256Gcm!);
  config.protocolExtensions.push(SshProtocolExtensionNames.sessionReconnect);
  config.protocolExtensions.push(SshProtocolExtensionNames.sessionLatency);
  config.addService(PortForwardingService);
  // In the ssh function, change the WebSocket instantiation:
  const websocket = new WebSocket(serverURI, "ssh");

  const stream = await new Promise<Stream>((resolve, reject) => {
    websocket.on("open", () => {
      console.log("[WebSocket] Connection opened, creating stream");
      resolve(new connectionClientStream(websocket));
    });

    websocket.on("error", (event: Event) => {
      const errorMessage = (event as ErrorEvent).message || "Unknown error";
      console.error(`[WebSocket] Connection error: ${errorMessage}`);
      reject(
        new Error(
          `Failed to connect to server at ${serverURI}: ${errorMessage}`,
        ),
      );
    });

    // Add a timeout in case the connection hangs
    setTimeout(() => {
      if (!websocket.readyState || websocket.readyState !== 1) { // 1 = OPEN
        console.error("[WebSocket] Connection timeout");
        reject(new Error(`Connection timeout to ${serverURI}`));
      }
    }, 10000); // 10 second timeout
  });
  const session = new SshClientSession(config);
  try {
    await session.connect(stream);
    void session.onAuthenticating((error) => {
      // there is no authentication in this solution
      error.authenticationPromise = Promise.resolve({});
    });
    const opts = {
      displayName: "test",
      client: { port: "33333" },
      username: "user",
      pkFilePath: "./container-key",
    };
    await session.authenticateClient({
      username: opts.username,
      publicKeys: [],
    });
    const pfs: PortForwardingService = session.activateService(
      PortForwardingService,
    );
    const localPort: number = parseInt(opts.client.port, 10);
    await pfs.forwardToRemotePort(
      "127.0.0.1",
      localPort,
      "127.0.0.1",
      2223,
    );

    sessionMap.set(serverURI, session);

    const sshArgs: string[] = [
      "-v",
      "-i",
      opts.pkFilePath,
      "-p",
      `${localPort}`,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null", // Avoids polluting known_hosts for localhost ports
      `${opts.username}@127.0.0.1`,
    ];

    await spawnProcess("ssh", sshArgs, {
      stdio: "inherit",
      env: process.env,
      onExit(exitCode: number | null, signalCode) {
        // When the user’s ssh exits, close the tunneled session cleanly
        console.log(
          `SSH process exited (code=${exitCode}, signal=${signalCode}), closing tunnel…`,
        );
        void session.close(SshDisconnectReason.byApplication)
          .catch((err) => console.error("Error closing SSH session:", err));
        sessionMap.delete(serverURI);
        closeSessions();
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log(`SSH session dropped : ${error?.message}`);
    }
  }
}

testSSH().catch((error) => {
  console.error(`[Client] Unhandled error: ${error.message}`);
  process.exit(1);
});
