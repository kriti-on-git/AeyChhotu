-- 022_order_workflow_outbox.sql
--
-- Durable Orders -> Tickets -> Kitchen hand-off.
--
-- The order (and its ticket projection) is still created by fire_order() in
-- one transaction. This table records the kitchen-notification fact in that
-- SAME transaction, so a crash after COMMIT cannot lose it. A single
-- dispatcher claims pending rows, calls the Kitchen intake port and marks the
-- row processed. Delivery is at-least-once; the handler is read-only, so a
-- replay cannot create a second ticket.

CREATE TABLE IF NOT EXISTS order_workflow_outbox (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  table_id        uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One kitchen hand-off per order event. A retried fire cannot enqueue twice.
  CONSTRAINT order_workflow_outbox_order_event_uq UNIQUE (order_id, event)
);

-- Dispatcher scan: oldest eligible pending row first.
CREATE INDEX IF NOT EXISTS order_workflow_outbox_pending_idx
  ON order_workflow_outbox (next_attempt_at, id)
  WHERE status = 'pending';

-- Ordering check: an earlier pending row for the same table blocks a later one.
CREATE INDEX IF NOT EXISTS order_workflow_outbox_table_pending_idx
  ON order_workflow_outbox (table_id, id)
  WHERE status = 'pending';

-- Retention cleanup of processed rows.
CREATE INDEX IF NOT EXISTS order_workflow_outbox_processed_idx
  ON order_workflow_outbox (processed_at)
  WHERE status = 'processed';
