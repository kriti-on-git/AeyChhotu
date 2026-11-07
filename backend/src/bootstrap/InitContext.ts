/* InitContext — everything a component may depend on, passed explicitly.

   A child NEVER receives its parent. It gets:
     * the frozen configuration,
     * a logger it can child-scope,
     * a clock,
     * the container, from which it resolves only the ports it declared.

   That is the whole surface. Anything a component needs beyond this belongs in
   its own constructor arguments when the module factory builds it — which is
   where a module's real dependencies are visible and testable in isolation. */

import type { Clock } from "../infrastructure/clock/Clock.js";
import type { AppConfig } from "../infrastructure/config/ConfigManager.js";
import type { Logger } from "../infrastructure/logging/Logger.js";
import type { Container } from "./Container.js";

export interface InitContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly container: Container;
}
