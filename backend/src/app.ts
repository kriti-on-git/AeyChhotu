import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import {
  adminLoginLimiter,
  apiLimiter,
  ipSafetyLimiter,
  staffLoginLimiter,
} from "./middleware/rate-limit.js";
import {
  createMenuRouter,
  type MenuServicePort,
} from "./modules/menu/index.js";
import {
  createTableRouter,
  getDefaultTableService,
  type TableServicePort,
} from "./modules/table/index.js";
import {
  createCartRouter,
  type CartServicePort,
} from "./modules/cart/index.js";
import {
  createOrdersRouter,
  type OrdersServicePort,
} from "./modules/orders/index.js";
import { createInventoryRouter, type InventoryServicePort } from "./modules/inventory/index.js";
import {
  createConversationRouter,
  type ConversationServicePort,
} from "./modules/conversation/index.js";
import type { BillingServicePort } from "./modules/billing/index.js";
import type { KitchenServicePort } from "./modules/kitchen/index.js";
import type { TicketServicePort } from "./modules/tickets/index.js";
import {
  createAuthRouter,
  createStaffRouter,
  type StaffServicePort,
} from "./modules/staff/index.js";
import { getDefaultStaffService } from "./services/staff.service.js";
import { requestContext } from "./observability/logger.js";
import { healthRouter } from "./routes/health.js";
import { readyRouter } from "./routes/ready.js";
import { createKdsRouter } from "./routes/kds.js";
import { floorRouter } from "./routes/floor.js";
import { createBillingMount } from "./routes/billing.js";
import { adminRouter } from "./routes/admin.js";
import { getDefaultCartService } from "./services/cart.service.js";
import { getDefaultOrdersService } from "./services/orders.service.js";
import { createKitchenServiceFor } from "./services/kitchen.service.js";
import { getDefaultBillingService } from "./services/billing.service.js";
import { getDefaultInventoryService } from "./services/inventory.service.js";
import { getDefaultTicketsService } from "./services/tickets.service.js";
import { recordFeedback } from "./services/insights.service.js";
import { getDefaultMenuService } from "./services/menu.service.js";
import { readMenuItemImage } from "./services/menu-image.service.js";

/* Dev convenience: a phone opening the Next dev server at http://192.168.x.x:3000
   sends an Origin that CLIENT_URL cannot list in advance (DHCP changes it), so
   every API call would fail CORS and the UI would look broken rather than
   unauthorised. Relax the allow-list to loopback and RFC 1918 addresses in
   DEVELOPMENT only; production still answers exactly to CLIENT_URL. */
const DEV_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$/;

/* Shared with the Socket.IO server so REST and realtime answer the same
   allow-list in every environment. */
export function originAllowed(origin: string): boolean {
  if (env.clientUrls.includes(origin)) return true;
  return env.nodeEnv !== "production" && DEV_ORIGIN_RE.test(origin);
}

/* Dependencies the composition root may inject. `createApp()` with no options
   still works — it builds the Table module's compatibility service over the
   shared pool — which keeps scripts and ad-hoc boots unchanged. */
export interface AppOptions {
  readonly tableService?: TableServicePort;
  readonly menuService?: MenuServicePort;
  readonly cartService?: CartServicePort;
  readonly ordersService?: OrdersServicePort;
  readonly ticketsService?: TicketServicePort;
  readonly kitchenService?: KitchenServicePort;
  readonly billingService?: BillingServicePort;
  readonly inventoryService?: InventoryServicePort;
  readonly staffService?: StaffServicePort;
  readonly conversationService?: ConversationServicePort;
  readonly recordFeedback?: (
    tableToken: string,
    input: { rating: number; comment: string },
  ) => Promise<unknown>;
}

/* Express app factory: security headers → request ids → CORS (CLIENT_URL
   only) → rate limits → routes → 404 → central error handler (registration
   order matters). */
export function createApp(options: AppOptions = {}) {
  const app = express();

  app.disable("x-powered-by");

  /* Security headers. CSP is not applied here: Next.js owns the page
     shell and the API serves JSON only, where a document CSP is a no-op
     with a foot-gun cost. If this service ever renders HTML, add
     helmet.contentSecurityPolicy() with a real policy then. */
  app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
  app.use(helmet.noSniff());
  app.use(helmet.referrerPolicy({ policy: "strict-origin-when-cross-origin" }));
  app.use(helmet.xssFilter());
  app.use(helmet.frameguard({ action: "deny" }));
  // HSTS only makes sense over TLS; in production the reverse proxy/enforceHttps
  // path is always https, in dev (http://localhost) it would poison the browser.
  if (env.nodeEnv === "production") {
    app.use(helmet.hsts({ maxAge: 15552000 }));
  }

  // Request ids + ndjson access logs (first middleware, so everything after
  // — including error handlers — can log with the same correlation id).
  app.use(requestContext);

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
        callback(null, originAllowed(requestOrigin));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "X-Table-Token",
        "X-Table-Secret",
        "X-Participant-Id",
      ],
      // Cache the preflight so every mutating call doesn't pay for an extra
      // round trip once the browser has learned the policy.
      maxAge: 86_400,
    }),
  );

  // JSON body parsing for mutating requests.
  app.use(express.json({ limit: "1mb" }));

  /* Rate limits. Order matters: the login limiters must be mounted BEFORE
     the general limiter so their failed-attempt-only budgets are what apply
     to the PIN walls (the general limiter would otherwise count successes
     too, punishing a busy kitchen). Kitchen/floor and admin have separate
     counters, and the API budget is per credential rather than per shared
     restaurant IP — see middleware/rate-limit.ts. */
  app.use("/api/v1/auth/kds-login", staffLoginLimiter);
  app.use("/api/v1/auth/admin-login", adminLoginLimiter);
  app.use("/api/v1", ipSafetyLimiter);
  app.use("/api/v1", apiLimiter);

  // Routes (docs/7-api-contract.md E1–E17; health/ready stay public).
  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/ready", readyRouter);
  app.use(
    "/api/v1/sessions",
    createTableRouter({
      service: options.tableService ?? getDefaultTableService(),
      recordFeedback: options.recordFeedback ?? recordFeedback,
    }),
  );
  app.use(
    "/api/v1/auth",
    createAuthRouter({
      service: options.staffService ?? getDefaultStaffService(),
      cookie: { sameSite: env.cookieSameSite, secure: env.cookieSecure },
    }),
  );
  app.use(
    "/api/v1/staff",
    createStaffRouter({ service: options.staffService ?? getDefaultStaffService() }),
  );
  app.use(
    "/api/v1/menu",
    createMenuRouter({
      service: options.menuService ?? getDefaultMenuService(),
      readImage: readMenuItemImage,
    }),
  );
  app.use(
    "/api/v1/cart/items",
    createCartRouter({ service: options.cartService ?? getDefaultCartService() }),
  );
  app.use(
    "/api/v1/orders",
    createOrdersRouter({ service: options.ordersService ?? getDefaultOrdersService() }),
  );
  /* The KDS surface is Kitchen's. A caller that injects only a Tickets
     service (existing tests/scripts) still gets a working board wrapped in
     the Kitchen contract, just without realtime. */
  const tickets = options.ticketsService ?? getDefaultTicketsService();
  app.use(
    "/api/v1/kds",
    createKdsRouter({
      kitchen: options.kitchenService ?? createKitchenServiceFor(tickets),
    }),
  );
  app.use(
    "/api/v1/billing",
    createBillingMount({
      service: options.billingService ?? getDefaultBillingService(),
    }),
  );
  app.use(
    "/api/v1/inventory",
    createInventoryRouter({
      service: options.inventoryService ?? getDefaultInventoryService(),
    }),
  );
  /* Additive conversation surface. It is mounted only when a service was
     composed, so a bare createApp() (scripts, focused tests) keeps exactly
     the old route set. */
  if (options.conversationService) {
    app.use(
      "/api/v1/conversations",
      createConversationRouter({ service: options.conversationService }),
    );
  }
  app.use("/api/v1/floor", floorRouter);
  app.use("/api/v1/admin", adminRouter);

  // Terminal 404, then the central error handler (must stay last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
