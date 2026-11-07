import "dotenv/config";

import type { Server } from "node:http";
import { createApp, originAllowed } from "./app.js";
import { AppBootstrap } from "./bootstrap/AppBootstrap.js";
import type { InitContext } from "./bootstrap/InitContext.js";
import type { ManagedComponent } from "./bootstrap/lifecycle.js";
import { TOKENS } from "./bootstrap/tokens.js";
import { pool } from "./db/pool.js";
import { registerDomainEvents, type DomainEventMap } from "./events/domain-events.js";
import { DatabaseManager } from "./infrastructure/database/DatabaseManager.js";
import { EventManager } from "./infrastructure/events/EventManager.js";
import { HealthManager } from "./infrastructure/health/HealthManager.js";
import { IOManager } from "./infrastructure/realtime/IOManager.js";
import type { TableEventPublisher } from "./modules/table/table.events.js";
import { configureTableService, createTableModule } from "./modules/table/table.module.js";
import { createReadTokenIssuer } from "./modules/table/table.read-token.js";
import { TABLE_TOKENS } from "./modules/table/table.tokens.js";
import { createMenuModule } from "./modules/menu/menu.module.js";
import { MENU_TOKENS } from "./modules/menu/menu.tokens.js";
import { createInventoryModule } from "./modules/inventory/inventory.module.js";
import { INVENTORY_TOKENS } from "./modules/inventory/inventory.tokens.js";
import { createStaffModule } from "./modules/staff/staff.module.js";
import { STAFF_TOKENS } from "./modules/staff/staff.tokens.js";
import { createConversationModule } from "./modules/conversation/conversation.module.js";
import { CONVERSATION_TOKENS } from "./modules/conversation/conversation.tokens.js";
import { createCartModule } from "./modules/cart/cart.module.js";
import { CART_TOKENS } from "./modules/cart/cart.tokens.js";
import { createOrdersModule } from "./modules/orders/orders.module.js";
import { ORDERS_TOKENS } from "./modules/orders/orders.tokens.js";
import type { OrdersEventPublisher } from "./modules/orders/orders.types.js";
import { createTicketsModule } from "./modules/tickets/tickets.module.js";
import { TICKETS_TOKENS } from "./modules/tickets/tickets.tokens.js";
import type { TicketEventPublisher } from "./modules/tickets/tickets.types.js";
import { createKitchenModule } from "./modules/kitchen/kitchen.module.js";
import { KITCHEN_TOKENS } from "./modules/kitchen/kitchen.tokens.js";
import type { KitchenEventPublisher } from "./modules/kitchen/kitchen.types.js";
import { createBillingModule } from "./modules/billing/billing.module.js";
import { BILLING_TOKENS } from "./modules/billing/billing.tokens.js";
import type { BillingEventPublisher } from "./modules/billing/billing.types.js";
import { createRealtimeAuthenticator } from "./realtime/authenticator.js";
import { recordTableActivitySample } from "./services/admin.service.js";
import { imageDtoFromRow } from "./services/menu-image.service.js";
import { configureCartService } from "./services/cart.service.js";
import { configureMenuService } from "./services/menu.service.js";
import { configureInventoryService } from "./services/inventory.service.js";
import { configureOrdersService } from "./services/orders.service.js";
import { configureTicketsService } from "./services/tickets.service.js";
import { configureKitchenService } from "./services/kitchen.service.js";
import { configureBillingService } from "./services/billing.service.js";
import { configureStaffService } from "./services/staff.service.js";
import { checkAndAutoReleaseTable } from "./services/sessions.service.js";

/* App entry point — the composition root for THIS application.

   It is the only file that knows the app is made of an Express server, a
   Postgres pool and two periodic jobs. AppBootstrap itself imports no business
   code; everything arrives through `componentFactory`, and shutdown order is
   the reverse of this list:

     health  →  database  →  events  →  staff  →  table  →  orders  →  tickets
             →  kitchen  →  billing  →  menu  →  inventory  →  cart
             →  conversation  →  database.pool  →  jobs.auto-release-sweeper
             →  jobs.table-activity-sampler  →  http.server  →  realtime

   Initialization has no side effects on the outside world (no timers, no
   listener belt), which is why the components below implement only start() and
   shutdown(). The production behaviour of booting even while Postgres is
   briefly unreachable is preserved on purpose: /ready reports 503 until the
   database answers, and the orchestrator does not restart a healthy process. */

const AUTO_RELEASE_SWEEP_MS = 20_000;
const TABLE_ACTIVITY_SAMPLE_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const HTTP_DRAIN_MS = 8_000;

/* The single database manager repositories will receive through DI
   (TOKENS.database). Created here, registered on the container inside the
   factory below, and initialized first so any component that resolves it sees
   a ready pool. */
const database = new DatabaseManager();

/* The internal domain bus. It carries in-process facts ("an order was
   created"), never socket traffic — a dropped socket is routine, a dropped
   domain event is a bug. Business modules receive it through constructor
   injection when they migrate; it never replaces their explicit interfaces. */
const events = new EventManager<DomainEventMap>({ name: "events" });

/* Adapts the Table module's narrow publisher to the internal bus. The
   mapping lives at the composition root so the module itself imports neither
   the transport nor the global event catalog. */
function tableEventPublisher(manager: EventManager<DomainEventMap>): TableEventPublisher {
  return {
    sessionStarted: ({ tableId, code }) => {
      manager.emitDetached("table.session.started", { tableId, code });
    },
    sessionCleared: ({ tableId, reason, billStatus }) => {
      manager.emitDetached("table.session.cleared", { tableId, reason, billStatus });
    },
    billRequested: ({ tableId, code }) => {
      manager.emitDetached("table.bill.requested", { tableId, code });
    },
  };
}

/* Adapts the Orders module's narrow publisher to the internal bus. The
   mapping lives at the composition root so the module imports neither the
   transport nor the global event catalog. */
function ordersEventPublisher(
  manager: EventManager<DomainEventMap>,
): OrdersEventPublisher {
  return {
    orderCreated: ({ orderId, tableId, itemCount }) => {
      manager.emitDetached("order.created", { orderId, tableId, itemCount });
    },
    ticketCreated: ({ ticketId, orderId, tableId }) => {
      manager.emitDetached("ticket.created", { ticketId, orderId, tableId });
    },
    orderDenied: ({ orderId, tableId, reason }) => {
      manager.emitDetached("order.denied", { orderId, tableId, reason });
    },
  };
}

/* Billing announces a recorded payment; it never publishes the bill itself
   (a generated bill is a read model, not an event). */
function billingEventPublisher(
  manager: EventManager<DomainEventMap>,
): BillingEventPublisher {
  return {
    billSettled: ({ tableId, billPaidAt }) => {
      manager.emitDetached("bill.settled", { tableId, billPaidAt });
    },
  };
}

/* Adapts the Tickets module's narrow publisher to the internal bus. The
   Kitchen module will consume these facts without the ticket module knowing
   who (if anyone) is listening. */
function ticketEventPublisher(
  manager: EventManager<DomainEventMap>,
): TicketEventPublisher {
  return {
    ticketAdvanced: ({ ticketId, orderId, status }) => {
      manager.emitDetached("ticket.status.changed", { ticketId, orderId, status });
    },
    ticketServed: ({ ticketId, orderId, tableId }) => {
      manager.emitDetached("ticket.served", { ticketId, orderId, tableId });
    },
    ticketDenied: ({ ticketId, orderId, reason }) => {
      manager.emitDetached("ticket.denied", { ticketId, orderId, reason });
    },
  };
}

/* Adapts the Kitchen module's narrow publisher to the internal bus. Kitchen
   adds only the facts it originates; Ticket already announces every status
   move. */
function kitchenEventPublisher(
  manager: EventManager<DomainEventMap>,
): KitchenEventPublisher {
  return {
    ticketIncoming: ({ ticketId, orderId, tableId }) => {
      manager.emitDetached("kitchen.ticket.incoming", { ticketId, orderId, tableId });
    },
    ticketCompleted: ({ ticketId, orderId }) => {
      manager.emitDetached("kitchen.ticket.completed", { ticketId, orderId });
    },
  };
}

function createComponents(ctx: InitContext): readonly ManagedComponent[] {
  ctx.container.registerValue(TOKENS.database, database);
  registerDomainEvents(events);

  /* The Table module is created here, before any request is served, and is
     registered on the container and on the compatibility seam so the legacy
     services and the HTTP controller share one service instance. */
  const tableModule = createTableModule({
    db: database,
    events: tableEventPublisher(events),
    issueReadToken: createReadTokenIssuer(ctx.config.supabaseJwtSecret),
    assistantKey: ctx.config.geminiApiKey,
  });
  configureTableService(tableModule.service);
  ctx.container.registerValue(TABLE_TOKENS.service, tableModule.service);

  /* Staff owns shift identity, both login walls and the permission matrix.
     The same instance is registered on the container and on the compatibility
     seam so the legacy auth exports and the HTTP controller agree. */
  const staffModule = createStaffModule({
    db: database,
    staffPin: ctx.config.staffPin,
    adminPin: ctx.config.adminPin,
    kdsTokenSecret: ctx.config.kdsTokenSecret,
    supabaseJwtSecret: ctx.config.supabaseJwtSecret,
  });
  configureStaffService(staffModule.service);
  ctx.container.registerValue(STAFF_TOKENS.service, staffModule.service);

  /* The Orders module owns firing, history and the denied-round lifecycle.
     It consumes Table only to resolve a table token; the atomic create stays
     in fire_order(), inside Postgres. */
  const ordersModule = createOrdersModule({
    db: database,
    tables: tableModule.service,
    events: ordersEventPublisher(events),
    onPublishError: (err) => ctx.logger.warn("order_event_publish_failed", { error: err }),
  });
  configureOrdersService(ordersModule.service);
  ctx.container.registerValue(ORDERS_TOKENS.service, ordersModule.service);

  /* The Tickets module owns the kitchen ticket projection and its state
     machine. It reads the order association through its own read model and
     asks Table's release engine whether serving has freed the seating. */
  const ticketsModule = createTicketsModule({
    db: database,
    release: tableModule.service,
    events: ticketEventPublisher(events),
    onPublishError: (err) => ctx.logger.warn("ticket_event_publish_failed", { error: err }),
  });
  configureTicketsService(ticketsModule.service);
  ctx.container.registerValue(TICKETS_TOKENS.service, ticketsModule.service);

  /* The Menu module consumes Table through its public port and Orders through
     a narrow denial port; it owns no pool of its own. */
  const menuModule = createMenuModule({
    db: database,
    tables: tableModule.service,
    orders: ordersModule.service,
    images: { toDto: imageDtoFromRow },
  });
  configureMenuService(menuModule.service);
  ctx.container.registerValue(MENU_TOKENS.service, menuModule.service);

  /* Inventory owns the stock columns on menu_items and the movement ledger.
     It reads catalogue rows directly (the documented shared-row partition),
     never another module's repository, and exposes stock policy through its
     service port. */
  const inventoryModule = createInventoryModule({ db: database });
  configureInventoryService(inventoryModule.service);
  ctx.container.registerValue(INVENTORY_TOKENS.service, inventoryModule.service);

  let sweepTimer: NodeJS.Timeout | null = null;
  let activityTimer: NodeJS.Timeout | null = null;
  let server: Server | null = null;

  /* Socket.IO rides the same HTTP server the API binds to, so it is built
     here where that server is in scope. It starts after http.server and shuts
     down before it (reverse order), which lets every socket be disconnected
     while the listener is still alive. Credentials are validated by the
     existing JWT / table-session rules through the injected authenticator. */
  const realtime = new IOManager({
    serverProvider: () => server,
    authenticator: createRealtimeAuthenticator(ctx.config),
    isOriginAllowed: originAllowed,
  });

  /* The Kitchen module owns the KDS surface: it reads the Ticket board, asks
     Ticket to perform every move, and announces committed moves to the
     kitchen room through RealtimePublisher — never a raw Socket.IO handle. */
  const kitchenModule = createKitchenModule({
    db: database,
    tickets: ticketsModule.service,
    realtime,
    events: kitchenEventPublisher(events),
    assistantKey: ctx.config.geminiApiKey,
    onPublishError: (err) => ctx.logger.warn("kitchen_publish_failed", { error: err }),
  });
  configureKitchenService(kitchenModule.service);
  ctx.container.registerValue(KITCHEN_TOKENS.service, kitchenModule.service);

  /* Billing owns bill generation, exact money arithmetic and settlement. It
     reads the frozen order lines through its repository and asks Table's
     release engine after payment; it never clears a table or writes orders. */
  const billingModule = createBillingModule({
    db: database,
    release: tableModule.service,
    events: billingEventPublisher(events),
    onPublishError: (err) => ctx.logger.warn("billing_event_publish_failed", { error: err }),
  });
  configureBillingService(billingModule.service);
  ctx.container.registerValue(BILLING_TOKENS.service, billingModule.service);

  /* Orders publishes this only after fire_order() commits, so the intake
     notification can never describe a ticket that does not exist. */
  events.on("ticket.created", (payload) =>
    kitchenModule.service.handleIncomingTicket(payload),
  );

  /* The Cart module consumes Menu only for a dish's availability/name and
     Table only for session scope. Realtime publication is best-effort: a
     committed cart write is never failed by a disconnected socket. */
  const cartModule = createCartModule({
    db: database,
    tables: tableModule.service,
    menu: menuModule.service,
    realtime,
    onPublishError: (err) => ctx.logger.warn("cart_realtime_publish_failed", { error: err }),
  });
  configureCartService(cartModule.service);
  ctx.container.registerValue(CART_TOKENS.service, cartModule.service);

  /* Conversation owns the shared transcript and voice coordination. Its AI
     tools call the Menu/Cart/Orders/Table services above, never SQL, and all
     broadcasts go through RealtimePublisher. The browser's Gemini Live
     session remains the audio transport; no second key is released. */
  const conversationModule = createConversationModule({
    db: database,
    realtime,
    menu: menuModule.service,
    cart: cartModule.service,
    orders: ordersModule.service,
    tables: tableModule.service,
    aiProvider: null,
    onPublishError: (err) =>
      ctx.logger.warn("conversation_publish_failed", { error: err }),
  });
  ctx.container.registerValue(CONVERSATION_TOKENS.service, conversationModule.service);

  /* Auto-release sweeper (sql/007_bill_and_auto_release.sql).

     Both event paths — the floor settling a bill and the last device
     disconnecting — already ask the engine directly. This is the safety net
     for the cases neither can see: a device dies without firing pagehide, a
     process restarts between the two events, or the last ticket is pruned
     after everyone has gone. Every 20 s it re-examines the only rows that can
     possibly be eligible (bill paid), and each check re-validates all three
     conditions under a row lock. */
  const sweepPaidTables = async (): Promise<void> => {
    try {
      const res = await pool.query<{ id: string }>(
        "SELECT id FROM restaurant_tables WHERE bill_status = 'paid' AND deleted_at IS NULL",
      );

      for (const row of res.rows) {
        await checkAndAutoReleaseTable(row.id).catch((err: unknown) => {
          ctx.logger.error("auto_release_failed", { table_id: row.id, error: err });
        });
      }
    } catch (err) {
      ctx.logger.error("auto_release_sweep_failed", { error: err });
    }
  };

  /* Floor-activity sampler (sql/014). A cheap periodic count is the honest
     source for the console's 24-hour average — there is no event that means
     "one more table is open". Five minutes gives twelve readings an hour. */
  const sampleTableActivity = async (): Promise<void> => {
    try {
      await recordTableActivitySample();
    } catch (err) {
      ctx.logger.error("table_activity_sample_failed", { error: err });
    }
  };

  const components: ManagedComponent[] = [
    database,
    events,
    staffModule,
    tableModule,
    ordersModule,
    ticketsModule,
    kitchenModule,
    billingModule,
    menuModule,
    inventoryModule,
    cartModule,
    conversationModule,
    {
      name: "database.pool",
      dependencies: [],
      /* The legacy pool is a shutdown shim, not a second health probe: the
         DatabaseManager probe already proves this process can reach Postgres
         with the same credentials, and probing the shim would double the
         database load for no extra signal. */
      health: () => ({
        state: "HEALTHY",
        message: "Legacy pool shim attached; the shared database probe covers connectivity.",
      }),
      /* TRANSITIONAL: this ends the legacy pool that backend/src/db/pool.ts
         still hands to the un-migrated services. It disappears together with
         that module when the first repository replaces its `pool.query`. */
      /* No init(): a boot must not depend on the database being up. */
      shutdown: async () => {
        await pool.end();
      },
    },
    {
      name: "jobs.auto-release-sweeper",
      dependencies: ["database.pool"],
      health: () =>
        sweepTimer === null
          ? { state: "DEGRADED", message: "The auto-release sweep timer is not running." }
          : { state: "HEALTHY", message: "The auto-release sweep timer is running." },
      start: () => {
        sweepTimer = setInterval(() => void sweepPaidTables(), AUTO_RELEASE_SWEEP_MS);
        sweepTimer.unref();
      },
      shutdown: () => {
        if (sweepTimer !== null) {
          clearInterval(sweepTimer);
          sweepTimer = null;
        }
      },
    },
    {
      name: "jobs.table-activity-sampler",
      dependencies: ["database.pool"],
      health: () =>
        activityTimer === null
          ? { state: "DEGRADED", message: "The table-activity sampler is not running." }
          : { state: "HEALTHY", message: "The table-activity sampler is running." },
      start: () => {
        // The first reading is taken at boot so a freshly started server
        // contributes immediately.
        void sampleTableActivity();
        activityTimer = setInterval(
          () => void sampleTableActivity(),
          TABLE_ACTIVITY_SAMPLE_MS,
        );
        activityTimer.unref();
      },
      shutdown: () => {
        if (activityTimer !== null) {
          clearInterval(activityTimer);
          activityTimer = null;
        }
      },
    },
    {
      name: "http.server",
      dependencies: [],
      health: () =>
        server !== null && server.listening
          ? { state: "HEALTHY", message: `The API is listening on port ${ctx.config.port}.` }
          : { state: "UNHEALTHY", message: "The HTTP server is not listening." },
      start: async () => {
        const app = createApp({
          tableService: tableModule.service,
          menuService: menuModule.service,
          cartService: cartModule.service,
          ordersService: ordersModule.service,
          ticketsService: ticketsModule.service,
          kitchenService: kitchenModule.service,
          billingService: billingModule.service,
          inventoryService: inventoryModule.service,
          staffService: staffModule.service,
          conversationService: conversationModule.service,
        });

        await new Promise<void>((resolve, reject) => {
          const listening = app.listen(ctx.config.port, () => {
            // The bind succeeded: swap the boot-time error trap for a runtime
            // log so a later server error is reported, not swallowed.
            listening.removeListener("error", reject);
            listening.on("error", (err: Error) => {
              ctx.logger.error("http_server_error", { error: err });
            });

            server = listening;
            ctx.logger.info("server_started", {
              port: ctx.config.port,
              node_env: ctx.config.nodeEnv,
              cors_origins: [...ctx.config.clientUrls],
            });
            resolve();
          });

          // A failed listen (EADDRINUSE) rejects here, which makes startAll()
          // roll the whole app back instead of running without a listener.
          listening.once("error", reject);
        });
      },
      /* Drain in-flight requests, then force the rest: a hung keep-alive
         socket must not hold the process past the platform's kill timeout.
         The force timer is deliberately shorter than the bootstrap budget so
         server.close() gets a chance to call back first. */
      shutdown: () =>
        new Promise<void>((resolve) => {
          const current = server;
          server = null;
          if (current === null) {
            resolve();
            return;
          }

          const force = setTimeout(() => {
            ctx.logger.warn("shutdown_forced", { timeout_ms: HTTP_DRAIN_MS });
            current.closeAllConnections();
          }, HTTP_DRAIN_MS);
          force.unref();

          current.close(() => {
            clearTimeout(force);
            resolve();
          });
        }),
    },
    realtime,
  ];

  /* HealthManager observes the same components the lifecycle runs. It is
     registered now, before initAll, so a boot check already sees the whole
     graph. It is returned FIRST so reverse shutdown stops it LAST: only then
     can it mark components STOPPED after they have actually stopped. */
  const health = new HealthManager({ name: "health" });
  health.registerAll(components);
  ctx.container.registerValue(TOKENS.health, health);

  return [health, ...components];
}

const bootstrap = new AppBootstrap({
  componentFactory: createComponents,
  installSignalHandlers: true,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
});

try {
  await bootstrap.run();
} catch (err) {
  // Configuration and initialization failures are fatal and loud, exactly as
  // before this refactor. The bootstrap has already unwound what it started.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[boot] FATAL: ${message}`);
  process.exit(1);
}
