import { Router } from "express";
import { fireOrder, getOrderStatus, listOrders } from "../services/orders.service.js";
import {
  fireSchema,
  orderStatusParamsSchema,
  ordersListQuerySchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 2 E8 (fire) + Module 4 E15 (status poll) / E16 (history). */
export const ordersRouter = Router();

// E8 — POST /api/v1/orders/fire (atomic inside fire_order())
ordersRouter.post("/fire", async (req, res) => {
  const body = parseOrThrow(fireSchema, req.body);
  const data = await fireOrder(body.table_token);
  res.status(201).json({ success: true, data });
});

// E16 — GET /api/v1/orders?table_token=…
ordersRouter.get("/", async (req, res) => {
  const query = parseOrThrow(ordersListQuerySchema, req.query);
  const { data, meta } = await listOrders(query);
  res.status(200).json({ success: true, data, meta });
});

// E15 — GET /api/v1/orders/:order_id/status
ordersRouter.get("/:order_id/status", async (req, res) => {
  const params = parseOrThrow(orderStatusParamsSchema, req.params);
  const data = await getOrderStatus(params.order_id);
  res.status(200).json({ success: true, data });
});
