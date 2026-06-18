import pg from "pg";
import { config } from "./config.js";

// A single shared pool. The connection string (and therefore the credentials)
// lives only here, on the server side.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Give up acquiring a connection rather than hanging forever.
  connectionTimeoutMillis: 10_000,
  max: 10,
});

export interface QueryResult {
  fields: string[];
  rows: unknown[][];
}

/**
 * Run a single SQL statement with a hard timeout.
 *
 * The timeout is enforced in two layers:
 *  1. PostgreSQL `statement_timeout` cancels the query server-side.
 *  2. A JS-level race rejects even if the connection itself stalls.
 */
export async function runQuery(sql: string): Promise<QueryResult> {
  const client = await pool.connect();
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
