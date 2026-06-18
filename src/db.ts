import pg from "pg";
import { config } from "./config.js";
import { log, errToObj } from "./logger.js";

// One connection pool per named database, created on first use. The connection
// strings (and therefore the credentials) live only here, on the server side.
const pools = new Map<string, pg.Pool>();

function getPool(dbName: string): pg.Pool {
  const key = dbName.toLowerCase();
  const connectionString = config.databases[key];
  if (!connectionString) {
    // Names are safe to disclose; connection strings/credentials are not.
    throw new Error(
      `Unknown database "${dbName}". Available: ${config.databaseNames.join(", ")}`,
    );
  }
  let pool = pools.get(key);
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      connectionTimeoutMillis: 10_000,
      // Close our own idle clients before a remote idle-session reaper does, so
      // we hand out fewer connections the server has already killed.
      idleTimeoutMillis: config.idleTimeoutMs,
      // TCP keepalive: keep sockets warm through NATs/proxies and surface dead
      // peers sooner instead of discovering them on the next query.
      keepAlive: true,
      max: 10,
    });
    // An idle pooled client can fail asynchronously (server restart, idle-session
    // reaper, network drop). pg surfaces that as a Pool 'error' event; without a
    // listener Node would treat it as unhandled and crash the process. We log and
    // let the pool evict the dead client — the next query gets a fresh one.
    pool.on("error", (err) => {
      log.warn("idle db client error (pool will evict it)", {
        database: key,
        ...errToObj(err),
      });
    });
    pools.set(key, pool);
  }
  return pool;
}

export interface QueryResult {
  fields: string[];
  rows: unknown[][];
}

// How many times to attempt a query when the connection turns out to be dead.
// Read-only queries are idempotent, so retrying on a fresh connection is safe.
const MAX_ATTEMPTS = 2;

// Node socket errors and PostgreSQL SQLSTATEs that mean "the connection is gone",
// as opposed to a problem with the query itself (e.g. a syntax error). Only these
// are worth retrying on a fresh connection.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // class 08 — connection_exception
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  // server going away
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    return /connection terminated|connection error|not queryable|server closed the connection|connection ended|terminating connection/i.test(
      message,
    );
  }
  return false;
}

/** Run the statement on an already-acquired client, with a hard timeout. */
async function runOnClient(client: pg.PoolClient, sql: string): Promise<QueryResult> {
  await client.query(`SET statement_timeout = ${config.queryTimeoutMs}`);

  const queryPromise = client.query({ text: sql, rowMode: "array" });

  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Query exceeded ${config.queryTimeoutMs}ms timeout`)),
      config.queryTimeoutMs + 1_000,
    );
  });

  try {
    const raw = await Promise.race([queryPromise, timeoutPromise]);
    // A multi-statement query yields an array of results; use the last one.
    // Commands that return no rows (INSERT/CREATE/...) may omit fields/rows.
    const result = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as pg.QueryArrayResult;
    return {
      fields: (result?.fields ?? []).map((f) => f.name),
      rows: result?.rows ?? [],
    };
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Run a single SQL statement against the named database.
 *
 * Resilience to dropped connections:
 *  - The timeout is enforced both server-side (`statement_timeout`) and in-process.
 *  - If the acquired connection turns out to be dead (the remote closed an idle
 *    session, the server restarted, a proxy timed it out), the dead client is
 *    destroyed — never returned to the pool — and the query is retried once on a
 *    fresh connection. Errors that are about the query itself are not retried.
 */
export async function runQuery(dbName: string, sql: string): Promise<QueryResult> {
  const pool = getPool(dbName);

  for (let attempt = 1; ; attempt++) {
    const lastAttempt = attempt >= MAX_ATTEMPTS;

    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      // Couldn't even acquire a connection. Retry once if it looks transient.
      if (!lastAttempt && isConnectionError(err)) {
        log.warn("db connect failed; retrying with a fresh connection", {
          database: dbName,
          attempt,
          ...errToObj(err),
        });
        continue;
      }
      throw err;
    }

    try {
      const result = await runOnClient(client, sql);
      client.release();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        // Destroy the (probably dead) client so the pool never reuses it.
        client.release(err instanceof Error ? err : true);
        if (!lastAttempt) {
          log.warn("db connection dropped mid-query; retrying on a fresh connection", {
            database: dbName,
            attempt,
            ...errToObj(err),
          });
          continue;
        }
      } else {
        client.release();
      }
      throw err;
    }
  }
}
