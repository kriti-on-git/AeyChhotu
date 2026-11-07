/* Conversation module — AI tools.

   THE MODEL NEVER TOUCHES THE DATABASE. Each tool is a thin adapter over an
   existing public service method, and the table capability is bound by the
   caller (validated membership), never taken from tool arguments. That keeps
   fire_order(), the one-active-order rule, inventory checks and table scoping
   exactly where they already live. */

import { AppError } from "../../errors/app-error.js";
import type {
  AiToolDeclaration,
  ConversationAction,
  ConversationBusinessPorts,
  ConversationToolContext,
  ConversationToolExecution,
  ConversationToolPort,
} from "./conversation.types.js";

export const CONVERSATION_TOOL_DECLARATIONS: readonly AiToolDeclaration[] = [
  {
    name: "get_menu",
    description:
      "Read today's menu. Use it before adding a dish so you have its menu_item_id and current availability.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text dish search." },
        category: { type: "string", description: "Menu category label." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_cart",
    description: "Read the shared table cart. Every guest sees the same cart.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_to_cart",
    description:
      "Add a dish to the shared table cart. Use a menu_item_id returned by get_menu; attribution is the current guest.",
    parameters: {
      type: "object",
      properties: {
        menu_item_id: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: 99 },
        request_note: { type: "string", maxLength: 500 },
        allergy_note: { type: "string", maxLength: 500 },
      },
      required: ["menu_item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_cart_item",
    description: "Change the quantity or notes of one shared cart line.",
    parameters: {
      type: "object",
      properties: {
        cart_item_id: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: 99 },
        request_note: { type: "string", maxLength: 500 },
        allergy_note: { type: "string", maxLength: 500 },
      },
      required: ["cart_item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_cart_item",
    description: "Remove one line from the shared table cart.",
    parameters: {
      type: "object",
      properties: { cart_item_id: { type: "string" } },
      required: ["cart_item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "fire_order",
    description:
      "Send the shared cart to the kitchen. This is a real order and drains the cart; confirm with the guests first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_orders",
    description: "Read the table's order history and current kitchen status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_bill",
    description: "Ask the floor for the table's bill.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

function text(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(
  args: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = args[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function fail(code: string, message: string): ConversationToolExecution {
  return { ok: false, data: { error: { code, message } } };
}

function fromError(err: unknown): ConversationToolExecution {
  if (err instanceof AppError) {
    return { ok: false, data: { error: { code: err.code, message: err.message } } };
  }
  return {
    ok: false,
    data: {
      error: {
        code: "TOOL_FAILED",
        message: err instanceof Error ? err.message : "The tool could not complete.",
      },
    },
  };
}

export class ConversationToolset implements ConversationToolPort {
  readonly declarations = CONVERSATION_TOOL_DECLARATIONS;
  private readonly ports: ConversationBusinessPorts;

  constructor(ports: ConversationBusinessPorts) {
    this.ports = ports;
  }

  async execute(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: ConversationToolContext,
  ): Promise<ConversationToolExecution> {
    try {
      switch (name) {
        case "get_menu": {
          const result = await this.ports.menu.listMenu({
            table_token: context.tableToken,
            page: 1,
            limit: 30,
            ...(text(args, "query") ? { q: text(args, "query") as string } : {}),
            ...(text(args, "category")
              ? { category: text(args, "category") as string }
              : {}),
          });
          return {
            ok: true,
            data: {
              count: result.data.length,
              dishes: result.data.map((item) => ({
                menu_item_id: item.menu_item_id,
                name: item.name,
                price: item.price,
                category: item.category,
                is_available: item.is_available,
                vegetarian: item.vegetarian,
                ingredients: item.ingredients,
                allergens: item.allergens,
                spice_level: item.spice_level,
                portion: item.portion_description,
              })),
            },
          };
        }

        case "get_cart": {
          const result = await this.ports.cart.listCart({
            table_token: context.tableToken,
            page: 1,
            limit: 100,
          });
          return {
            ok: true,
            data: {
              count: result.data.length,
              lines: result.data.map((line) => ({
                cart_item_id: line.id,
                menu_item_id: line.menu_item_id,
                quantity: line.quantity,
                added_by: line.added_by,
                request_note: line.request_note,
                allergy_note: line.allergy_note,
              })),
            },
          };
        }

        case "add_to_cart": {
          const menuItemId = text(args, "menu_item_id");
          if (!menuItemId) return fail("VALIDATION_ERROR", "menu_item_id is required.");
          const quantity = integer(args, "quantity") ?? 1;
          if (quantity < 1 || quantity > 99) {
            return fail("VALIDATION_ERROR", "quantity must be between 1 and 99.");
          }

          const line = await this.ports.cart.addItem({
            table_token: context.tableToken,
            menu_item_id: menuItemId,
            quantity,
            added_by: context.participantName,
            ...(text(args, "request_note")
              ? { request_note: text(args, "request_note") as string }
              : {}),
            ...(text(args, "allergy_note")
              ? { allergy_note: text(args, "allergy_note") as string }
              : {}),
          });
          const action: ConversationAction = {
            kind: "cart",
            label: `Added ${quantity} item(s) to the table cart`,
            ok: true,
          };
          return {
            ok: true,
            mutated: true,
            actions: [action],
            data: {
              cart_item_id: line.id,
              menu_item_id: line.menu_item_id,
              quantity: line.quantity,
              added_by: line.added_by,
              total_table_quantity: line.total_table_quantity,
            },
          };
        }

        case "update_cart_item": {
          const cartItemId = text(args, "cart_item_id");
          if (!cartItemId) return fail("VALIDATION_ERROR", "cart_item_id is required.");
          const quantity = integer(args, "quantity");
          const requestNote = text(args, "request_note");
          const allergyNote = text(args, "allergy_note");
          if (quantity === null && requestNote === null && allergyNote === null) {
            return fail("VALIDATION_ERROR", "Provide quantity, request_note or allergy_note.");
          }
          if (quantity !== null && (quantity < 1 || quantity > 99)) {
            return fail("VALIDATION_ERROR", "quantity must be between 1 and 99.");
          }

          const line = await this.ports.cart.updateItem(cartItemId, {
            table_token: context.tableToken,
            ...(quantity !== null ? { quantity } : {}),
            ...(requestNote !== null ? { request_note: requestNote } : {}),
            ...(allergyNote !== null ? { allergy_note: allergyNote } : {}),
          });
          return {
            ok: true,
            mutated: true,
            actions: [{ kind: "cart", label: "Updated the shared cart", ok: true }],
            data: {
              cart_item_id: line.id,
              quantity: line.quantity,
              request_note: line.request_note,
              allergy_note: line.allergy_note,
            },
          };
        }

        case "remove_cart_item": {
          const cartItemId = text(args, "cart_item_id");
          if (!cartItemId) return fail("VALIDATION_ERROR", "cart_item_id is required.");
          await this.ports.cart.removeItem(context.tableToken, cartItemId);
          return {
            ok: true,
            mutated: true,
            actions: [{ kind: "cart", label: "Removed a line from the shared cart", ok: true }],
            data: { cart_item_id: cartItemId, removed: true },
          };
        }

        case "fire_order": {
          const order = await this.ports.orders.fireOrder(context.tableToken);
          return {
            ok: true,
            mutated: true,
            actions: [{ kind: "order", label: `Fired order ${order.status} to the kitchen`, ok: true }],
            data: {
              order_id: order.order_id,
              status: order.status,
              message: order.message,
            },
          };
        }

        case "get_orders": {
          const orders = await this.ports.orders.listOrders({
            table_token: context.tableToken,
            page: 1,
            limit: 10,
          });
          return {
            ok: true,
            data: {
              count: orders.data.length,
              orders: orders.data.map((order) => ({
                order_id: order.order_id,
                status: order.status,
                denial_reason: order.denial_reason,
                total: order.total,
                created_at: order.created_at,
              })),
            },
          };
        }

        case "request_bill": {
          const bill = await this.ports.tables.requestTableBill(context.tableToken);
          return {
            ok: true,
            mutated: true,
            actions: [{ kind: "bill", label: "Asked the floor for the bill", ok: true }],
            data: {
              table_id: bill.table_id,
              bill_status: bill.bill_status,
              bill_requested_at: bill.bill_requested_at,
            },
          };
        }

        default:
          return fail("UNKNOWN_TOOL", `Unknown tool: ${name}`);
      }
    } catch (err) {
      return fromError(err);
    }
  }
}
