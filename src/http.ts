import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, type BellowsDeps } from "./server.ts";

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

export function startHttpServer(deps: BellowsDeps, port: number, host = "127.0.0.1"): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "Not found. The MCP endpoint is POST /mcp." }),
      );
      return;
    }
    if (req.method !== "POST") {
      res
        .writeHead(405, { "content-type": "application/json", allow: "POST" })
        .end(JSON.stringify({ error: "Stateless transport: only POST is supported." }));
      return;
    }

    // Stateless mode: a fresh MCP server per request, but all requests share the one
    // Supervisor so process ownership survives across calls.
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      const body = await readBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }),
        );
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`bellows: streamable HTTP transport listening on http://${host}:${port}/mcp`);
  });
  return httpServer;
}
