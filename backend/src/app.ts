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

  // CORS: only the client origin may read responses (preflight included).
  // The origin header is emitted only when the request's Origin matches
  // CLIENT_URL exactly; everyone else gets no CORS headers at all.
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        callback(null, requestOrigin === env.clientUrl);
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
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
