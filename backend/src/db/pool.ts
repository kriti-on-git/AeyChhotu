import { Pool } from "pg";
import { env } from "../config/env.js";

/* Single shared connection pool built from the DATABASE_URL env var
   (validated loudly in config/env.ts). Lazy by design: pg connects on the
   first query. No business code lives here yet. */

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/* An idle-client error means the database connection is broken — fail loudly
   instead of silently serving degraded responses. */
pool.on("error", (err: Error) => {
  console.error(`[db] FATAL: postgres pool error — ${err.message}`);
  process.exit(1);
});
