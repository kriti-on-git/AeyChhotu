# UI/UX Blueprint

## 1. Screen & Section Mapping List

Every single MVP feature is mapped directly to a dedicated interface layout or section:

| Screen | Route | Features Mapped |
|---|---|---|
| Screen 1: Diner Menu & Shared Cart View | `/table/[random_token]` | QR-Table Link, Shared Table Cart, Quick Item Hide (86ing) |
| Screen 2: Diner Checkout Confirmation Modal | *(triggered by cart button)* | "Review & Fire" Button, Red Allergy Text Input |
| Screen 3: Diner Live Progress Tracker Screen | — | Live Guest Tracker, Screen Flash Alert |
| Screen 4: Kitchen Authentication Wall | `/kitchen` | Staff PIN Gatekeep |
| Screen 5: Kitchen Kanban Display Dashboard | — | Kitchen Kanban Board, One-Tap Status Updates, Red Allergy Text Display, Screen Sounds Activation, Quick Item Hide Panel |

---

## Low-Fi Wireframe Layouts & Component Breakdown

### Screen 1: Diner Menu & Shared Cart View (`/table/[random_token]`)

```text
+-------------------------------------------------------+

| [lbl: Table k7x2p]         [comp: ActiveDinersBadge]  |
+-------------------------------------------------------+

| [comp: SearchBar - Text Field]                        |
+-------------------------------------------------------+

| [Category: Main Course]                               |
| +---------------------------------------------------+ |
| | [lbl: Masala Dosa]                    [btn: +Add] | |
| +---------------------------------------------------+ |
| | [lbl: Paneer Butter Masala] (Greyed out/Disabled) | |
| | [lbl: OUT OF STOCK]                               | |
| +---------------------------------------------------+ |
+-------------------------------------------------------+

| [comp: StickyBottomCartStrip]                         |
|  [lbl: 3 Items in Table Cart]          [btn: View]    |
+-------------------------------------------------------+
```

- **Description:** The customer landing zone. It identifies the table instantly. Items disabled by the kitchen layout display a clean gray block override. The bottom strip updates live as other diners drop food items into the system.

**Must-Have Component Checklist:**

- **ActiveDinersBadge:** Visual counter showing how many active phones are synced to the same room.
- **StickyBottomCartStrip:** A persistent screen footer aggregating the shared total order value.

### Screen 2: Diner Checkout Confirmation Modal (Triggered by Cart Button)

```text
+-------------------------------------------------------+

| [btn: Close X]               [lbl: Review Table Cart] |
+-------------------------------------------------------+

|  - 2x Masala Dosa (Added by Amit)                     |
|  - 1x Veg Noodles (Added by Rahul)                    |
+-------------------------------------------------------+

| [txt: Standard Instructions - "extra sauce, etc."]    |
+-------------------------------------------------------+

| [box: High-Contrast Boundary]                         |
| [lbl: 🚨 Medical Allergies Only]                      |
| [txt: Allergy Input Field - Maps to allergy_note]     |
+-------------------------------------------------------+

| [btn: BIG FIRE ORDER BUTTON]                          |
+-------------------------------------------------------+
```

- **Description:** The final gatekeeper window before pushing to the kitchen line. It explicitly isolates the `allergy_note` container from general notes so consumers do not dilute the data bucket.

**Must-Have Component Checklist:**

- **AllergyInputBox:** A dedicated text region styled distinctively from normal text inputs.

### Screen 3: Diner Live Progress Tracker Screen

```text
+-------------------------------------------------------+

| [lbl: Table k7x2p - Status Tracker]                   |
+-------------------------------------------------------+

|                                                       |
|                 [comp: StatusVisualCircle]            |
|                     ( Current: PREPARING )            |
|                                                       |
+-------------------------------------------------------+

| [lbl: Chef is cooking your table's order right now!]  |
+-------------------------------------------------------+
```

- **Description:** The anxiety-reducer interface. Relies entirely on real-time triggers to dynamically alter background states.

**Must-Have Component Checklist:**

- **StatusVisualCircle:** A simple, central progress layout that controls full-screen color flashes when transitioning to Ready.

### Screen 4: Kitchen Authentication Wall (`/kitchen`)

```text
+-------------------------------------------------------+

|                                                       |
|             [lbl: Enter Kitchen Staff PIN]            |
|                 [txt: PIN Input Field]                |
|                                                       |
|             [ 1 ]    [ 2 ]    [ 3 ]                   |
|             [ 4 ]    [ 5 ]    [ 6 ]                   |
|             [ 7 ]    [ 8 ]    [ 9 ]                   |
|                      [ 0 ]                            |
|                                                       |
+-------------------------------------------------------+
```

- **Description:** A clean keypad panel masking the operational dashboard from customers attempting to access it manually via guessed links.

### Screen 5: Kitchen Kanban Display Dashboard

```text
+-------------------------------------------------------+

| [btn: START SHIFT & ENABLE AUDIO 🔊] [btn: Manage 86] |
+-------------------------------------------------------+

|  PENDING (1)   |  PREPARING (0)   |    READY (2)      |
| ---------------| -----------------| ----------------- |
| [comp: KdsCard]|                  |                   |
| Table: k7x2p   |                  |                   |
| 2m elapsed     |                  |                   |
|                |                  |                   |
| 2x Dosa        |                  |                   |
| !! ALLERGY !!  |                  |                   |
| NO PEANUTS     |                  |                   |
|                |                  |                   |
| [btn: COOK ->] |                  |                   |
+-------------------------------------------------------+
```

- **Description:** The command center layout for Mr. Baawarchi. Three explicit columns. Tapping **Manage 86** slides open a quick item availability panel overlay to toggle out-of-stock items.

**Must-Have Component Checklist:**

- **KdsCard:** A functional order layout tracking elapsed processing duration, structural allergy strings, and a single context-sensitive advancement toggle button.

---

## UX Optimization Strategies for the 4-Day Sprint

1. **Ditch the Traditional Quantity Counter in Menu Feed:** Do not place numeric counter UI widgets (`[-] 1 [+]`) directly on the main index catalog rows for the MVP. Keep it down to a single `[+ Add]` click event. If a user wants to modify quantities or remove items, force them to do it within the Cart Modal viewport. This keeps the real-time layout changes minimal.
2. **Combine the "Ready" and "Served" Pipeline Actions:** To save frontend UI real estate, the Line Chef uses the exact same button context pattern on a KdsCard. When the ticket is in the Ready column, that single button transforms automatically into a `[Mark Served]` event handler, executing data pruning in one click.
3. **Local Storage Crash Resilience:** For the anonymous diner session, save the randomized `table_token` string directly into the mobile browser's localStorage context window immediately upon scanning. If a customer accidentally closes their browser tab or refreshes mid-meal, they boot straight back into their live table cart state without creating an orphaned session.
