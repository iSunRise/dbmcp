# dbmcp

A small **MCP server** that proxies SQL queries to PostgreSQL. It:

- **Routes to multiple databases by name** — callers pick `devDb`, `stageDb`,
  etc. (case-insensitive). Each can live on a different host with different
  credentials; the caller only ever knows the name.
- **Isolates credentials** — the caller sends SQL and gets results back; the
  connection strings live only in the server's environment and are never returned.
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
- `dbmcp` — the MCP server, mapped to host port `${HOST_PORT:-3991}`.
- `devdb`, `stagedb` — two optional local PostgreSQL servers (different users,
  passwords, and hostnames) for testing multi-database routing. In real use,
  delete them and point the `DB_*_URL` env vars at your actual hosts.

### Configuring databases

Each database is one env var following the `DB_<NAME>_URL` convention; the
`<NAME>` becomes the case-insensitive name callers use:

```bash
DB_DEVDB_URL=postgres://devuser:devpass@dev-host:5432/dev       # -> "devDb"
DB_STAGEDB_URL=postgres://stageuser:secret@stage-host:5432/app  # -> "stageDb"
DB_PRODDB_URL=postgres://readonly:secret@prod-host:5432/app     # -> "prodDb"
```

Optionally set `DATABASE_URL` as the unnamed default used when a caller omits
`database`. If exactly one database is configured, it is the default
automatically.

> Node is pinned to `node:24.16.0-alpine` (the latest published Node 24 LTS;
> `24.17.0` is not yet on Docker Hub).

## MCP endpoint

Streamable HTTP, stateless, at `POST /mcp`. Two tools:

| Tool             | Input                                          | Returns                                       |
|------------------|------------------------------------------------|-----------------------------------------------|
| `query`          | `sql` (string), `database` (string, see below) | truncated preview + metadata + public CSV URL |
| `list_databases` | none                                           | available database names + the default (names only — never credentials) |

`database` selects which configured database to run against (case-insensitive).
It is optional when a default exists, otherwise required.

Example (raw JSON-RPC over HTTP):

```bash
curl -s -X POST http://localhost:3991/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"query","arguments":{"database":"devDb","sql":"SELECT * FROM demo"}}}'
```

Response payload (inside the MCP tool result text):

```json
{
  "columns": ["id", "big_text", "label"],
  "rows": [["1", "xxxx…", "row-1"], ...],
  "metadata": {
    "database": "devDb",
    "totalRows": 50,
    "returnedRows": 6,
    "truncatedColumns": ["big_text"],
    "cellsTruncated": true,
    "rowsOmitted": true,
    "csvUrl": "http://localhost:3991/files/<uuid>.csv",
    "note": "Showing first 6 of 50 rows. Fetch <url> for the full result."
  }
}
```

Fetch the full result:

```bash
curl -s http://localhost:3991/files/<uuid>.csv | grep something
```

## Connecting a client

The server speaks **Streamable HTTP** at `http://localhost:3991/mcp`. Start it
first (`docker compose up`), then point your client at that URL. None of the
options below require Node on your host — they connect over HTTP directly.

### Claude Code (CLI)

```bash
claude mcp add --transport http dbmcp http://localhost:3991/mcp
claude mcp list            # should show dbmcp as connected
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "dbmcp": { "type": "http", "url": "http://localhost:3991/mcp" }
  }
}
```

### Cursor (cursor-cli)

Add the server to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "dbmcp": { "url": "http://localhost:3991/mcp" }
  }
}
```

Then list tools from the CLI:

```bash
cursor-agent mcp list
```

### Codex (CLI)

Codex reads `~/.codex/config.toml`. Recent versions speak Streamable HTTP
natively:

```toml
experimental_use_rmcp_client = true

[mcp_servers.dbmcp]
url = "http://localhost:3991/mcp"
```

```bash
codex mcp list             # verify dbmcp shows up
```

### Fallback: older clients that only support stdio

If a client can't talk HTTP directly, bridge stdio→HTTP with `mcp-remote`
(this one *does* run a Node helper on the host):

```jsonc
// Claude Code / Cursor
{ "mcpServers": { "dbmcp": {
    "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3991/mcp"]
} } }
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.dbmcp]
command = "npx"
args = ["-y", "mcp-remote", "http://localhost:3991/mcp"]
```

Once connected, call `list_databases` to see available names, then `query`
with a `database` and `sql`.

## Configuration (env)

| Variable           | Default                  | Purpose                                              |
|--------------------|--------------------------|------------------------------------------------------|
| `HOST_PORT`        | `3991`                   | Host port mapped to the container.                   |
| `DB_<NAME>_URL`    | —                        | A named database connection (server-side only).      |
| `DATABASE_URL`     | —                        | Optional unnamed default database.                   |
| `QUERY_TIMEOUT_MS` | `30000`                  | Hard per-query timeout.                              |
| `MAX_OUTPUT_CHARS` | `1000`                   | Inline payload cap.                                  |
| `MAX_CELL_CHARS`   | `100`                    | Per-cell truncation length.                          |
| `PUBLIC_BASE_URL`  | `http://localhost:3991`  | Base URL used in CSV links.                          |

## Security notes

- Callers never receive the connection string or password — only query results.
- The server runs **arbitrary SQL** as the configured role, so connect it with a
  least-privilege (ideally read-only) database user.
- Exported CSVs are world-readable by anyone who can reach `/files/<uuid>.csv`;
  the filename is an unguessable UUID, but treat the endpoint as public.
