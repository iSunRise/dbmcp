# dbmcp

A small **MCP server** that proxies SQL queries to PostgreSQL. It:

- **Isolates credentials** — the caller sends SQL and gets results back; the
  `DATABASE_URL` lives only in the server's environment and is never returned.
- **Enforces a hard timeout** — every query is capped (default **30s**) both by
  PostgreSQL `statement_timeout` and by an in-process backstop.
- **Shrinks output** — the inline response is kept under **1000 characters**:
  each cell is truncated to the first **100 characters**, and only the leading
  rows that fit are returned.
- **Reports what was cut** — metadata includes the total row count, which
  columns were truncated, and whether rows were omitted.
- **Exports the full result as a public CSV** — the complete, untruncated result
  is written to `/files/<uuid>.csv`, served from the same server so callers can
  fetch and `grep` it.

Everything runs **inside Docker** — no Node packages are installed on the host.

## Run

```bash
cp .env.example .env        # set DATABASE_URL etc.
docker compose up --build   # builds the image and runs the server
```

This starts:
- `dbmcp` — the MCP server, mapped to host port `${HOST_PORT:-3000}`.
- `db` — an optional local PostgreSQL for testing (host port `${DB_HOST_PORT:-5432}`).
  Point `DATABASE_URL` at your own database to skip it.

> Node is pinned to `node:24.16.0-alpine` (the latest published Node 24 LTS;
> `24.17.0` is not yet on Docker Hub).

## MCP endpoint

Streamable HTTP, stateless, at `POST /mcp`. One tool:

| Tool    | Input            | Returns                                              |
|---------|------------------|------------------------------------------------------|
| `query` | `sql` (string)   | truncated preview + metadata + public CSV URL        |

Example (raw JSON-RPC over HTTP):

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"query","arguments":{"sql":"SELECT * FROM demo"}}}'
```

Response payload (inside the MCP tool result text):

```json
{
  "columns": ["id", "big_text", "label"],
  "rows": [["1", "xxxx…", "row-1"], ...],
  "metadata": {
    "totalRows": 50,
    "returnedRows": 6,
    "truncatedColumns": ["big_text"],
    "cellsTruncated": true,
    "rowsOmitted": true,
    "csvUrl": "http://localhost:3000/files/<uuid>.csv",
    "note": "Showing first 6 of 50 rows. Fetch <url> for the full result."
  }
}
```

Fetch the full result:

```bash
curl -s http://localhost:3000/files/<uuid>.csv | grep something
```

## Configuration (env)

| Variable           | Default                                | Purpose                                   |
|--------------------|----------------------------------------|-------------------------------------------|
| `HOST_PORT`        | `3000`                                 | Host port mapped to the container.        |
| `DATABASE_URL`     | `postgres://app:app@db:5432/app`       | PostgreSQL connection (server-side only). |
| `QUERY_TIMEOUT_MS` | `30000`                                | Hard per-query timeout.                   |
| `MAX_OUTPUT_CHARS` | `1000`                                 | Inline payload cap.                       |
| `MAX_CELL_CHARS`   | `100`                                  | Per-cell truncation length.               |
| `PUBLIC_BASE_URL`  | `http://localhost:3000`                | Base URL used in CSV links.               |
| `DB_HOST_PORT`     | `5432`                                 | Host port for the bundled Postgres.       |

## Security notes

- Callers never receive the connection string or password — only query results.
- The server runs **arbitrary SQL** as the configured role, so connect it with a
  least-privilege (ideally read-only) database user.
- Exported CSVs are world-readable by anyone who can reach `/files/<uuid>.csv`;
  the filename is an unguessable UUID, but treat the endpoint as public.
