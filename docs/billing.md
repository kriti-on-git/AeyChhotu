# Billing

## Authority

`backend/src/modules/billing/` is the only authority for bill arithmetic.
Clients may render the response, but they must not recompute totals, tax,
discounts or per-guest allocations as the source of truth.

A bill is a **read model over frozen orders**, not a second ledger:

- `orders.total` and `order_items.unit_price` were written when the order was
  fired, so a later menu re-price cannot change an existing bill;
- denied rounds are excluded because they were never cooked and are not a debt;
- bill generation writes nothing and is idempotent for one seating;
- `bill_id` is deterministic: `<table_id>:<session_started_at | open>`.

## Arithmetic

All money is computed in integer paise, never floating point:

```
line_total_minor = unit_price_minor × quantity
subtotal_minor   = Σ line_total_minor
discount_minor   = min(configured_discount_minor, subtotal_minor)
taxable_minor    = subtotal_minor − discount_minor
tax_minor        = round(taxable_minor × tax_rate_bps / 10000)
total_minor      = taxable_minor + tax_minor
```

Tax and discount are supported by the service but default to **zero** until the
restaurant configures a rate. No client can set a rate or discount. Currency is
INR; strings are formatted from minor units for display.

## Allocations

`added_by` on each frozen order line determines ownership:

- a non-empty name allocates the whole line to that guest;
- an empty `added_by` means the dish is shared and appears under `Table`;
- per-guest entries are sorted by name, with the shared `Table` entry last.

Allocations are informational splits of the same subtotal. They do not change
the total and they do not create separate payable bills.

## Status and settlement

`status` is `unrequested`, `requested` or `paid`, owned by the table session.
Settlement is the only billing write:

1. mark the table paid;
2. ask Table's release engine whether the table can be released;
3. publish `bill.settled` only on the first transition to paid.

A release-engine failure does not turn a recorded payment into an HTTP error.
The periodic sweeper re-evaluates release later; the response returns
`released: false` rather than claiming a release that did not happen.

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/billing/tables/:table_id/guest` | participant token, principal's table must match the path | diner bill |
| `GET /api/v1/billing/tables/:table_id` | staff JWT (`floor`, `kitchen`, `admin`) | staff bill |
| `PATCH /api/v1/billing/tables/:table_id/settle` | staff JWT (`floor`, `kitchen`, `admin`) | take payment |
| `PATCH /api/v1/floor/tables/:table_id/settle` | staff JWT | legacy settlement path, same service/response |

`PATCH` settlement returns the unchanged settle payload:

```json
{
  "table_id": "uuid",
  "bill_status": "paid",
  "bill_paid_at": "ISO-8601",
  "released": false
}
```

The guest route deliberately does not accept a table token as sufficient
authority. A participant from another table gets `403 NOT_TABLE_MEMBER`, even
with a valid UUID.
