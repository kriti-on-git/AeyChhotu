/* Public surface of the Phase 5.2 realtime outbox. */

export { RealtimeOutboxRepository } from "./realtime-outbox.repository.js";
export {
  RealtimeOutboxDispatcher,
  type DispatchOutcome,
  type DispatcherOptions,
} from "./realtime-outbox.dispatcher.js";
export {
  createRealtimeOutboxModule,
  type RealtimeOutboxModule,
  type RealtimeOutboxModuleOptions,
  type RealtimeOutboxService,
} from "./realtime-outbox.module.js";
export {
  CONVERSATION_EVENT_PREFIX,
  TERMINAL_SESSION_EVENT,
  type ConversationOutboxPort,
  type OutboxEnqueueInput,
  type RealtimeOutboxHealth,
  type RealtimeOutboxPublisher,
  type RealtimeOutboxRow,
  type RealtimeOutboxStatus,
} from "./realtime-outbox.types.js";
