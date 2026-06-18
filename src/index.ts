import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import { runQuery } from "./db.js";
import { buildPreview, writeCsv } from "./format.js";

// Build a fresh MCP server instance. The single tool runs SQL and returns a
// truncated preview plus a link to the full CSV export.
function buildServer(): McpServer {
  const server = new McpServer({
    name: "dbmcp",
    version: "1.0.0",
  });

  server.registerTool(
    "query",
    {
      title: "Run SQL query",
      description:
        "Execute a read SQL statement against the configured PostgreSQL database. " +
        "Returns a truncated preview (cells capped at " +
        `${config.maxCellChars} chars, payload capped at ${config.maxOutputChars} chars) ` +
        "plus metadata and a public CSV URL containing the full, untruncated result.",
      inputSchema: {
        sql: z.string().describe("The SQL statement to execute."),
      },
    },
    async ({ sql }) => {
      try {
        const result = await runQuery(sql);
        const csvUrl = await writeCsv(result);
        const preview = buildPreview(result, csvUrl);
        return {
          content: [{ type: "text", text: JSON.stringify(preview) }],
        };
      } catch (err) {
        // Surface the error message but never the connection string / credentials.
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Serve exported CSV files. These are intentionally public so callers can fetch
// and grep them. They contain query results only — never credentials.
app.use(
  "/files",
  express.static(config.filesDir, {
    setHeaders: (res) => res.setHeader("Content-Type", "text/csv; charset=utf-8"),
  }),
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// MCP over Streamable HTTP, stateless: a new server+transport per request.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.listen(config.port, () => {
  console.log(`dbmcp listening on port ${config.port}`);
  console.log(`  MCP endpoint:  POST /mcp`);
  console.log(`  CSV files:     GET  /files/<id>.csv`);
  console.log(`  Public base:   ${config.publicBaseUrl}`);
});
