import { Buffer } from "node:buffer";
import { BaseStream, ObjectDisposedError } from "@microsoft/dev-tunnels-ssh";
import type { connection } from "websocket";

/**
 * TypeScript implementation of WebSocketServerStream
 */
export class WebSocketServerStream extends BaseStream {
  private websocket: connection;

  constructor(websocket: connection) {
    super();
    this.websocket = websocket;

    if (!websocket) {
      throw new TypeError("WebSocket is required.");
    }

    // Handle incoming WebSocket messages
    websocket.on("message", (data) => {
      if (data.type === "binary") {
        console.log(
          `[WebSocketServerStream] Received binary message, size: ${
            data.binaryData?.length || "unknown"
          }`,
        );
        this.onData(Buffer.from(data.binaryData));
      }
    });

    // Handle WebSocket close events
    websocket.on("close", (code?: number, reason?: string) => {
      console.log(
        `[WebSocketServerStream] Connection closed, code: ${code}, reason: ${reason}`,
      );
      if (typeof code === "undefined" || !code) {
        this.onEnd();
      } else {
        const error = new Error(reason) as Error & { code?: number };
        error.code = code;
        this.onError(error);
      }
    });

    // Handle WebSocket errors
    websocket.on("error", (error: Error) => {
      console.error(
        `[WebSocketServerStream] WebSocket error: ${error.message}`,
      );
      this.onError(error);
    });
  }

  async write(data: Buffer): Promise<void> {
    if (!data) {
      throw new TypeError("Data is required.");
    }

    if (this.disposed) {
      throw new ObjectDisposedError(this);
    }

    console.log(
      `[WebSocketServerStream] Sending binary data, size: ${data.length}`,
    );
    this.websocket.send(data);
    return Promise.resolve();
  }

  async close(error?: Error): Promise<void> {
    if (this.disposed) {
      throw new ObjectDisposedError(this);
    }

    if (!error) {
      console.log("[WebSocketServerStream] Closing connection normally");
      this.websocket.close();
    } else {
      console.log(
        `[WebSocketServerStream] Closing connection with error: ${error.message}`,
      );
      const code = typeof (error as any).code === "number"
        ? (error as any).code
        : undefined;
      this.websocket.drop(code, error.message);
    }

    this.disposed = true;
    this.closedEmitter.fire({ error });
    this.onError(error || new Error("Stream closed."));
    return Promise.resolve();
  }

  dispose(): void {
    if (!this.disposed) {
      console.log("[WebSocketServerStream] Disposing connection");
      this.websocket.close();
    }
    super.dispose();
  }
}
