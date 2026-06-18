// All runtime configuration is read from the environment so that database
// credentials never have to be hard-coded or exposed to callers.

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Discover named databases from the environment.
//   DB_DEVDB_URL=postgres://...   -> "devdb"
//   DB_STAGEDB_URL=postgres://... -> "stagedb"
// Plus an optional unnamed DATABASE_URL, registered as "default".
// Names are stored lowercased and matched case-insensitively, so a caller may
// pass "devDb", "DEVDB", etc. Each database can live on its own host with its
// own credentials — none of which are ever returned to callers.
function discoverDatabases(): Record<string, string> {
  const databases: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^DB_(.+)_URL$/.exec(key);
    if (match && value) {
      databases[match[1].toLowerCase()] = value;
    }
  }
  if (process.env.DATABASE_URL) {
    databases["default"] = process.env.DATABASE_URL;
  }
  return databases;
}

const databases = discoverDatabases();
const databaseNames = Object.keys(databases).sort();

// Which database to use when the caller doesn't name one: an explicit
// "default", or the sole database if only one is configured.
const defaultDb = databases["default"]
  ? "default"
  : databaseNames.length === 1
    ? databaseNames[0]
    : undefined;

export const config = {
  // HTTP port the server listens on inside the container.
  port: intEnv("PORT", 3000),

  // name -> connection string. Kept server-side only; never returned to callers.
  databases,
  databaseNames,
  defaultDb,

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

if (databaseNames.length === 0) {
  console.error(
    "FATAL: no databases configured. Set DATABASE_URL and/or DB_<NAME>_URL env vars.",
  );
  process.exit(1);
}
