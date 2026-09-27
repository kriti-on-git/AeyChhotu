import { Router } from "express";
import { addCartItem, listCart, removeCartItem, updateCartItem } from "../services/cart.service.js";
import {
  cartAddSchema,
  cartDeleteSchema,
  cartItemParamsSchema,
  cartListQuerySchema,
  cartUpdateSchema,
  parseOrThrow,
} from "../validation/schemas.js";

/* Module 2 shared cart: E4 read, E5 upsert, E6 update, E7 remove. */
export const cartRouter = Router();

// E4 — GET /api/v1/cart/items?table_token=…
cartRouter.get("/", async (req, res) => {
  const query = parseOrThrow(cartListQuerySchema, req.query);
  const { data, meta } = await listCart(query);
  res.status(200).json({ success: true, data, meta });
});

// E5 — POST /api/v1/cart/items
cartRouter.post("/", async (req, res) => {
  const body = parseOrThrow(cartAddSchema, req.body);
  const data = await addCartItem(body);
  res.status(200).json({ success: true, data });
});

// E6 — PATCH /api/v1/cart/items/:cart_item_id
cartRouter.patch("/:cart_item_id", async (req, res) => {
  const params = parseOrThrow(cartItemParamsSchema, req.params);
  const body = parseOrThrow(cartUpdateSchema, req.body);
  const data = await updateCartItem(params.cart_item_id, body);
  res.status(200).json({ success: true, data });
});

// E7 — DELETE /api/v1/cart/items
cartRouter.delete("/", async (req, res) => {
  const body = parseOrThrow(cartDeleteSchema, req.body);
  const data = await removeCartItem(body.table_token, body.cart_item_id);
  res.status(200).json({ success: true, data });
});
