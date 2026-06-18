import pg from "pg";
import { config } from "./config.js";

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
      max: 10,
    });
    pools.set(key, pool);
  }
  return pool;
}

export interface QueryResult {
  fields: string[];
  rows: unknown[][];
}

/**
 * Run a single SQL statement against the named database with a hard timeout.
 *
 * The timeout is enforced in two layers:
 *  1. PostgreSQL `statement_timeout` cancels the query server-side.
 *  2. A JS-level race rejects even if the connection itself stalls.
 */
export async function runQuery(dbName: string, sql: string): Promise<QueryResult> {
  const client = await getPool(dbName).connect();
  try {
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
  } finally {
    client.release();
  }
}
