/* Compatibility seam for the Billing module.

   Production supplies the service from the composition root. The legacy
   `settleTableBill` export uses this default, built on the legacy pool and the
   shared Table service, so existing tests/scripts keep the exact settle
   behaviour without composing the whole app. */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { BillingRepository } from "../modules/billing/billing.repository.js";
import { BillingService } from "../modules/billing/billing.service.js";
import { NOOP_BILLING_EVENTS } from "../modules/billing/billing.events.js";
import type { BillingServicePort } from "../modules/billing/billing.types.js";
import { getDefaultTableService } from "../modules/table/index.js";

let defaultService: BillingServicePort | null = null;

export function getDefaultBillingService(): BillingServicePort {
  if (defaultService === null) {
    defaultService = new BillingService({
      repository: new BillingRepository(createLegacyDbPort()),
      release: getDefaultTableService(),
      events: NOOP_BILLING_EVENTS,
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureBillingService(service: BillingServicePort): void {
  defaultService = service;
}
