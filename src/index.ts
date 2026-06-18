import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import { runQuery } from "./db.js";
import { buildPreview, writeCsv } from "./format.js";
import { log, errToObj } from "./logger.js";

// Build a fresh MCP server instance. The single tool runs SQL and returns a
// truncated preview plus a link to the full CSV export.
function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "dbmcp",
      version: "1.0.0",
    },
    {
      // Server-level guidance. MCP clients (e.g. Claude) surface this into the
      // model's context to explain when/how to use the whole server — separate
      // from each tool's own description.
      instructions:
        "Use this server when answering a question requires live data from the " +
        `configured PostgreSQL databases (${config.databaseNames.join(", ")}). ` +
        "Call `list_databases` first if you are unsure which database holds the " +
        "data, then `query` with a single SELECT. Queries are intended to be " +
        "read-only — do not run INSERT/UPDATE/DELETE/DDL. Results return as a " +
        "truncated preview plus a public CSV URL with the full, untruncated " +
        "result set; fetch that URL when you need rows beyond the preview.",
    },
  );

  const dbList = config.databaseNames.join(", ");
  const databaseField = config.defaultDb
    ? z
        .string()
        .optional()
        .describe(
          `Which database to query (case-insensitive). Available: ${dbList}. ` +
            `Defaults to "${config.defaultDb}" if omitted.`,
        )
    : z
        .string()
        .describe(`Which database to query (case-insensitive). Available: ${dbList}.`);

  server.registerTool(
    "query",
    {
      title: "Run SQL query",
      description:
        "Execute a read SQL statement against one of the configured PostgreSQL " +
        `databases (${dbList}). Returns a truncated preview (cells capped at ` +
        `${config.maxCellChars} chars, payload capped at ${config.maxOutputChars} chars) ` +
        "plus metadata and a public CSV URL containing the full, untruncated result.",
      inputSchema: {
        sql: z.string().describe("The SQL statement to execute."),
        database: databaseField,
      },
    },
    async ({ sql, database }) => {
      try {
        const dbName = database ?? config.defaultDb;
        if (!dbName) {
          throw new Error(`No database specified. Available: ${dbList}`);
        }
        const result = await runQuery(dbName, sql);
        const csvUrl = await writeCsv(result);
        const preview = buildPreview(result, dbName, csvUrl);
        log.info("query ok", {
          database: dbName,
          totalRows: preview.metadata.totalRows,
          returnedRows: preview.metadata.returnedRows,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(preview) }],
        };
      } catch (err) {
        // Surface the error message but never the connection string / credentials.
        const message = err instanceof Error ? err.message : String(err);
        log.error("query failed", { database: database ?? config.defaultDb, error: message });
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description:
        "List the names of databases available to query. Returns names only — " +
        "never hosts, users, or connection strings.",
      inputSchema: {},
    },
    async () => {
      const payload = {
        databases: config.databaseNames,
        default: config.defaultDb ?? null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Reply with a JSON-RPC-shaped error so clients never receive a bare `{}`.
function rpcError(res: express.Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", id: null, error: { code, message } });
}

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
  const contentType = String(req.headers["content-type"] ?? "");
  const accept = String(req.headers["accept"] ?? "");
  const body = req.body && typeof req.body === "object" ? req.body : undefined;
  const method = (body as { method?: string } | undefined)?.method;
  const tool = (body as { params?: { name?: string } } | undefined)?.params?.name;

  log.info("mcp request", {
    method,
    tool,
    contentType,
    hasAuth: Boolean(req.headers.authorization),
    ua: req.headers["user-agent"],
  });

  // 1) Auth (only enforced when a token is configured).
  if (config.authToken) {
    const provided = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (provided !== config.authToken) {
      log.warn("mcp auth rejected", { method, hasAuth: Boolean(req.headers.authorization) });
      return rpcError(res, 401, -32001, "Unauthorized: missing or invalid 'Authorization: Bearer <token>' header.");
    }
  }

  // 2) Content-Type must be JSON, or express leaves req.body as `{}`.
  if (!/application\/json/i.test(contentType)) {
    log.warn("mcp bad content-type", { contentType });
    return rpcError(res, 415, -32700, `Unsupported Content-Type "${contentType || "(none)"}". Send 'Content-Type: application/json'.`);
  }

  // 3) Body must be a non-empty JSON-RPC message.
  if (!body || Object.keys(body).length === 0) {
    log.warn("mcp empty body");
    return rpcError(res, 400, -32700, "Empty or unparsable JSON body. Send a valid JSON-RPC request with 'Content-Type: application/json'.");
  }

  // 4) Streamable HTTP requires the client to accept the SSE stream.
  if (!/text\/event-stream/i.test(accept)) {
    log.warn("mcp missing accept", { accept });
    return rpcError(res, 406, -32600, "Client must send 'Accept: application/json, text/event-stream'.");
  }

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
    log.error("mcp transport error", { method, tool, ...errToObj(err) });
    if (!res.headersSent) {
      rpcError(res, 500, -32603, "Internal server error handling MCP request.");
    }
  }
});

// This stateless endpoint has no SSE session to resume; reject GET/DELETE clearly.
app.all("/mcp", (req, res) => {
  log.warn("mcp unsupported method", { method: req.method });
  rpcError(res, 405, -32601, `This stateless MCP endpoint only accepts POST (received ${req.method}); it keeps no SSE session.`);
});

// Turn malformed-JSON (body-parser) and other errors into a clear reply, not HTML.
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error("unhandled express error", { path: req.path, ...errToObj(err) });
  if (res.headersSent) return next(err);
  rpcError(res, 400, -32700, `Malformed request: ${err.message}`);
});

process.on("unhandledRejection", (reason) => log.error("unhandledRejection", errToObj(reason)));
process.on("uncaughtException", (err) => log.error("uncaughtException", errToObj(err)));

app.listen(config.port, config.bindHost, () => {
  log.info("dbmcp started", {
    bind: `${config.bindHost}:${config.port}`,
    publicBaseUrl: config.publicBaseUrl,
    databases: config.databaseNames,
    defaultDb: config.defaultDb ?? null,
    authRequired: Boolean(config.authToken),
  });
});
