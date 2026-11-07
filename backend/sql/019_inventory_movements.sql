-- AeyChhotu! — 019_inventory_movements.sql
--
-- The Inventory module owns the stock columns on menu_items
-- (stock_quantity, low_stock_threshold, stock_updated_at) and records every
-- deliberate change here. A movement is an AUDIT ROW, not a second ledger of
-- money: it captures the before/after count and the reason, so a disputed
-- stocktake can be explained without replaying application logs.
--
-- `delta` is NULL only when the change crosses the "untracked" boundary
-- (NULL -> n, n -> NULL), because there is no meaningful difference between a
-- known count and an unknown one. `order_id` is a nullable citation: a manual
-- delivery or wastage movement has no order, and an order row may later be
-- removed when a denied round is dismissed.
--
-- Idempotent: safe to re-run from `npm run db:setup`.

CREATE TABLE IF NOT EXISTS inventory_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id      uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  delta             integer,
  previous_quantity integer,
  new_quantity      integer,
  reason            text NOT NULL CHECK (
                      reason IN ('manual', 'delivery', 'wastage', 'stocktake', 'order', 'order_restore')
                    ),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (delta IS NULL OR delta <> 0),
  CHECK (previous_quantity IS NULL OR previous_quantity >= 0),
  CHECK (new_quantity IS NULL OR new_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS inventory_movements_item_created_idx
  ON inventory_movements (menu_item_id, created_at DESC, id DESC);

/* Only the API writes or reads the ledger. Browser roles cannot see which
   dishes are low, because that is commercially sensitive stock information. */
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inventory_movements FROM anon, authenticated;
