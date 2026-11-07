import { z } from "zod";
import { note, pagination, tableToken, uuid } from "./primitives.js";

/* Zod schemas for every endpoint (docs/7 §1.7 validation rules).
   Unknown keys are stripped (never rejected) per §1.7. */


// ---- Module 1: Session & Access -------------------------------------

/* Owned by the Table module; re-exported here so existing importers keep one
   validation entry point and the contract has a single definition site. */
export {
  activeCheckParamsSchema,
  heartbeatSchema,
  initializeSchema,
  joinPassSchema,
  joinPinSchema,
  reconnectSchema,
  sessionTableParamsSchema,
} from "../modules/table/table.validation.js";

/* Login schemas are owned by the Staff module; re-exported here so existing
   importers keep one validation entry point and the contract has a single
   definition site. `surface` stays rate-limiter metadata only. */
export {
  adminLoginSchema,
  kdsLoginSchema,
} from "../modules/staff/staff.validation.js";

// ---- Module 2: Menu & Cart ------------------------------------------

/** E3 GET /api/v1/menu */
export { menuQuerySchema } from "../modules/menu/menu.validation.js";

/* Cart schemas are owned by the Cart module; re-exported here so existing
   importers keep one validation entry point. */
export {
  cartAddSchema,
  cartDeleteSchema,
  cartItemParamsSchema,
  cartListQuerySchema,
  cartUpdateSchema,
} from "../modules/cart/cart.validation.js";

/* Orders schemas are owned by the Orders module; re-exported here so existing
   importers keep one validation entry point. */
export {
  fireSchema,
  ordersListQuerySchema,
  orderStatusParamsSchema,
  orderStatusQuerySchema,
} from "../modules/orders/orders.validation.js";

/* KDS ticket schemas are owned by the Tickets module; re-exported here so
   existing importers keep one validation entry point. */
export {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
} from "../modules/tickets/tickets.validation.js";

/** E13 POST /api/v1/kds/shift/activate */
export const shiftActivateSchema = z.object({
  device_id: z.string().min(1, "device_id is required.").max(64, "device_id must be 64 characters or fewer."),
});

// ---- Module 4: Floor & availability ----------------------------------

/** E14 PATCH /api/v1/menu/items/:menu_item_id/availability */
export {
  availabilitySchema,
  menuImageParamsSchema,
  menuItemParamsSchema,
} from "../modules/menu/menu.validation.js";

/** E17 GET /api/v1/floor/tables */
export const floorQuerySchema = z.object({ ...pagination });

/** PATCH /api/v1/floor/tables/:table_id/settle */
export const floorTableParamsSchema = z.object({ table_id: uuid("table_id") });

/** PATCH /api/v1/floor/tables/:table_id/clear — `force` cancels an open ticket
    so staff can clear an occupied table without serving food nobody got. */
export const floorClearSchema = z.object({ force: z.boolean().optional().default(false) });

// ---- Module 5: Executive admin console --------------------------------

/** POST /api/v1/admin/tables */
export const adminCreateTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the table a name.")
    .max(60, "Table names must be 60 characters or fewer."),
});

/** PATCH /api/v1/admin/tables/:table_id */
export const adminUpdateTableSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The table name cannot be empty.")
    .max(60, "Table names must be 60 characters or fewer.")
    .optional(),
});

/** PATCH /api/v1/admin/tables/:table_id/code — repair a table's printed QR
    code. Uppercase is accepted and folded down by the service; the shape is
    the same 5–8 character alphabet every generated code uses. */
export const adminUpdateTableCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{5,8}$/, "Use 5–8 letters or digits, e.g. k7x2p16."),
});

/** Shared path params for the admin table sub-routes. */
export const adminTableParamsSchema = z.object({ table_id: uuid("table_id") });

export {
  adminCategoryParamsSchema,
  adminCreateCategorySchema,
  adminCreateMenuItemSchema,
  adminMenuItemParamsSchema,
  adminUpdateCategorySchema,
  adminUpdateMenuItemSchema,
} from "../modules/menu/menu.validation.js";

/* Validates a request slice and converts failures into the contract's
   400 VALIDATION_ERROR envelope with per-field messages (docs/7 §1.1).
   Kept re-exported so every existing route import is unchanged. */
export { parseOrThrow } from "./parse.js";
