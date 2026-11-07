/* Compatibility seam for the Kitchen module.

   Production supplies the service from the composition root. This default is
   for scripts and for createApp() without injection: it uses the legacy pool
   through a repository adapter and the single Tickets service, with no
   realtime or event bus attached. No query runs until the board/queue or an
   order lookup is actually requested. */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { KitchenRepository } from "../modules/kitchen/kitchen.repository.js";
import { KitchenService } from "../modules/kitchen/kitchen.service.js";
import type { KitchenServicePort, KitchenTicketPort } from "../modules/kitchen/kitchen.types.js";
import { getDefaultTicketsService } from "./tickets.service.js";

let defaultService: KitchenServicePort | null = null;

/** A kitchen service over an explicitly supplied Ticket port. */
export function createKitchenServiceFor(tickets: KitchenTicketPort): KitchenServicePort {
  return new KitchenService({
    tickets,
    repository: new KitchenRepository(createLegacyDbPort()),
  });
}

export function getDefaultKitchenService(): KitchenServicePort {
  if (defaultService === null) {
    defaultService = createKitchenServiceFor(getDefaultTicketsService());
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureKitchenService(service: KitchenServicePort): void {
  defaultService = service;
}
