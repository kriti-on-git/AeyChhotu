## Architectural Mapping of Modules

| Module | Feature Name | Description | CRUD | Endpoint | Request Body (JSON) | Affected Tables |
|---|---|---|---|---|---|---|
| 1. Session & Access | Anonymous Table Initialization | Generates a session via randomized link and binds it to a physical table without requiring a login. | Create | POST /api/v1/sessions/initialize | {"table_token": "k7x2p"} | tables |
| | KDS Shift Authentication | Gatekeeps the kitchen dashboard by checking an entered PIN against the system environment configuration. | Read | POST /api/v1/auth/kds-login | {"pin": "1234"} | None (Env Var Check) |
| 2. Collaborative Ordering | Live Menu Browsing | Displays active menu items to diners, automatically hiding or greying out out-of-stock items. | Read | GET /api/v1/menu?table_token=k7x2p | None | menu_items, tables |
| | Real-Time Shared Cart | Syncs item updates, quantities, and distinct allergy_note values across all devices at the same table. | Update | POST /api/v1/cart/items | {"table_token": "k7x2p", "menu_item_id": "uuid", "quantity": 2, "allergy_note": "No peanuts", "normal_note": ""} | cart_items, menu_items |
| | Cart Item Removal | Allows diners to delete an added line item from the shared table cart, instantly syncing across devices. | Delete | DELETE /api/v1/cart/items | {"table_token": "k7x2p", "cart_item_id": "uuid"} | cart_items |
| | "Review & Fire" Submission | Validates live inventory, empties the cart bucket, and routes a single grouped order to the kitchen. | Create | POST /api/v1/orders/fire | {"table_token": "k7x2p"} | cart_items, menu_items, orders, order_items |
| | Anti-Duplicate Guardrail | Blocks a second order submission from firing on an active session by checking processing statuses. | Read | GET /api/v1/sessions/:table_token/active-check | None | orders |
| 3. Kitchen Display System | KDS Kanban Dashboard | Pulls all active, grouped table tickets into live tracking columns (Pending, Preparing, Ready). | Read | GET /api/v1/kds/tickets | None | orders, order_items |
| | Guardrailed Allergy Rendering | Isolates allergy_note entries to style them in large, bold red text on the target kitchen ticket card. | Read | Inside KDS card data payload | None (Part of KDS ticket structure) | order_items |
| | One-Tap Tag State-Machine | Advances an order card through structural milestones via single tap gestures (Pending ➔ Preparing ➔ Ready). | Update | PATCH /api/v1/kds/tickets/:id/status | {"status_tag": "Preparing"} | orders |
| | Completed Ticket Pruning | Removes a card entirely from the active kitchen display once its status is marked as Served. | Update | PATCH /api/v1/kds/tickets/:id/prune | None | orders, tables |
| 4. Floor Operations | Live Guest Progress Tracker | Streams live status updates back to the diner browser, updating layout colors and flashing green when Ready. | Read | GET /api/v1/orders/:id/status | None (Fallback before WebSockets lock) | orders |
| | Screen Flash & Sounds | Registers the screen instance to bypass browser restrictions and play incoming audio chime pings. | Create | POST /api/v1/kds/shift/activate | {"device_id": "tablet-01"} | None (In-memory state) |
| | Quick Menu Hide (86ing) | Allows the chef or floor manager to instantly turn off a dish when an ingredient runs out during a rush. | Update | PATCH /api/v1/menu/items/:id/availability | {"is_available": false} | menu_items |


