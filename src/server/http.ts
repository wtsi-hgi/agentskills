import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import * as path from "node:path";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import type { Orchestrator } from "../orchestrator/machine";
import { validateAuth } from "./auth";
import { handleWebSocket } from "./ws";

type ServerHandle = {
  close(): void;
};

function getContentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain; charset=utf-8";
  }
}

function getRequestPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return decodeURIComponent(url.pathname);
}

function resolveStaticPath(staticDir: string, requestPath: string): string | undefined {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, relativePath);
  const root = path.resolve(staticDir);

  if (requestPath === "/") {
    return resolved;
  }

  return resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

async function handleHttpRequest(staticDir: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method Not Allowed");
    return;
  }

  const filePath = resolveStaticPath(staticDir, getRequestPath(request));
  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": getContentType(filePath) });
    response.end(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    response.writeHead(code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(code === "ENOENT" ? "Not Found" : "Internal Server Error");
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write([
    `HTTP/1.1 ${statusCode} ${message}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(message)}`,
    "",
    message,
  ].join("\r\n"));
  socket.destroy();
}

export async function startServer(
  port: number,
  staticDir: string,
  authToken: string,
  orchestrator: Orchestrator,
): Promise<ServerHandle> {
  const sockets = new Set<Socket>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    void handleHttpRequest(staticDir, request, response);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (getRequestPath(request) !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    if (!validateAuth(request.headers.authorization, authToken)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      handleWebSocket(ws, orchestrator);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closed = false;

  return {
    close(): void {
      if (closed) {
        return;
      }

      closed = true;
      for (const client of webSocketServer.clients) {
        client.close();
      }

      webSocketServer.close();
      server.close();
      server.closeAllConnections?.();
      server.closeIdleConnections?.();

      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}