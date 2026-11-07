/* Compatibility seam for createApp() with no injection.

   Production always supplies the Tickets service from the composition root.
   This default keeps scripts and ad-hoc boots working on the legacy pool, with
   the internal event bus absent and realtime release still delegated to the
   Table module's compatibility service. */

import { createLegacyDbPort } from "../db/legacy-db-port.js";
import { NOOP_TICKET_EVENTS } from "../modules/tickets/tickets.events.js";
import { TicketsRepository } from "../modules/tickets/tickets.repository.js";
import { TicketsService } from "../modules/tickets/tickets.service.js";
import type { TicketServicePort } from "../modules/tickets/tickets.types.js";
import { getDefaultTableService } from "../modules/table/index.js";

let defaultService: TicketServicePort | null = null;

export function getDefaultTicketsService(): TicketServicePort {
  if (defaultService === null) {
    /* One repository instance serves both the storage port and the order read
       port, so the projection is read consistently. */
    const repository = new TicketsRepository(createLegacyDbPort());
    defaultService = new TicketsService({
      repository,
      orders: repository,
      release: getDefaultTableService(),
      events: NOOP_TICKET_EVENTS,
    });
  }
  return defaultService;
}

/** Called once by the composition root before any request is served. */
export function configureTicketsService(service: TicketServicePort): void {
  defaultService = service;
}
