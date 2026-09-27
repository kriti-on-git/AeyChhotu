import { createApp } from "./app.js";
import { env } from "./config/env.js";
import "./db/pool.js";

/* App entry. Importing config/env.js validates required env vars and exits
   loudly if any are missing; importing db/pool.js wires the Postgres pool. */

const app = createApp();

app.listen(env.port, () => {
  console.log(`[server] AeyChhotu backend listening on http://localhost:${env.port}`);
  console.log(`[server] CORS origin: ${env.clientUrl} | NODE_ENV: ${env.nodeEnv}`);
});
