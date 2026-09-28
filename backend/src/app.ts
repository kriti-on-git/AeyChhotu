import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { healthRouter } from "./routes/health.js";
import { sessionsRouter } from "./routes/sessions.js";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { cartRouter } from "./routes/cart.js";
import { ordersRouter } from "./routes/orders.js";
import { kdsRouter } from "./routes/kds.js";
import { floorRouter } from "./routes/floor.js";

/* Express app factory: JSON parsing → CORS (CLIENT_URL only) → routes →
   404 → central error handler (registration order matters). */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  /* CORS: only allow-listed origins may read responses (preflight included).
     `credentials: true` is what lets the httpOnly kds_token cookie work when
     the frontend and API share a site — and it is also why the allow-list
     must be explicit: browsers forbid `Access-Control-Allow-Origin: *`
     together with credentials, so a wildcard is never an option here.

     Requests with no Origin header (health probes, curl, server-to-server,
     same-origin navigation) are allowed through: they are not cross-origin
     reads, and blocking them would break uptime monitoring. */
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) {
          callback(null, true);
          return;
        }
        callback(null, env.clientUrls.includes(requestOrigin));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      // Cache the preflight so every mutating call doesn't pay for an extra
      // round trip once the browser has learned the policy.
      maxAge: 86_400,
    }),
  );

  // JSON body parsing for mutating requests.
  app.use(express.json({ limit: "1mb" }));

  // Routes (docs/7-api-contract.md E1–E17; health stays public).
  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/sessions", sessionsRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/menu", menuRouter);
  app.use("/api/v1/cart/items", cartRouter);
  app.use("/api/v1/orders", ordersRouter);
  app.use("/api/v1/kds", kdsRouter);
  app.use("/api/v1/floor", floorRouter);

  // Terminal 404, then the central error handler (must stay last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
