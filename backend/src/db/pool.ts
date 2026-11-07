import { Pool } from "pg";
import { env } from "../config/env.js";

/* The process's single physical connection pool.

   DatabaseManager adopts this object through createDbPoolAdapter(); it owns
   health, diagnostics, transactions and shutdown. There is no second pool and
   no separate close path. Tests that need a different database construct a
   DatabaseManager with their own factory and never touch this module. */

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});

/* Idle-client errors are handled by DatabaseManager's fatal policy; do not
   install a second process.exit() here. */
