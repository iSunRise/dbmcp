// All runtime configuration is read from the environment so that database
// credentials never have to be hard-coded or exposed to callers.

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // HTTP port the server listens on inside the container.
  port: intEnv("PORT", 3000),

  // PostgreSQL connection string. Kept server-side only — never returned to callers.
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Hard query timeout in milliseconds (applied both at the DB and in-process).
  queryTimeoutMs: intEnv("QUERY_TIMEOUT_MS", 30_000),

  // Maximum size of the inline (non-CSV) response payload, in characters.
  maxOutputChars: intEnv("MAX_OUTPUT_CHARS", 1000),

  // Per-cell character cap for the inline preview.
  maxCellChars: intEnv("MAX_CELL_CHARS", 100),

  // Directory where exported CSV files are written and served from.
  filesDir: process.env.FILES_DIR ?? "/data/files",

  // Base URL callers use to fetch exported CSVs. Should be reachable from the host.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
};

if (!config.databaseUrl) {
  console.error("FATAL: DATABASE_URL is not set.");
  process.exit(1);
}
