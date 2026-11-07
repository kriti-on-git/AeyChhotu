/* An explicit InitContext for tests: fixture configuration, silent logger,
   real clock, empty container. Never reads the developer's .env. */

import { Container } from "../../src/bootstrap/Container.js";
import type { InitContext } from "../../src/bootstrap/InitContext.js";
import { systemClock } from "../../src/infrastructure/clock/Clock.js";
import { loadConfig } from "../../src/infrastructure/config/ConfigManager.js";
import { createLogger, silentSink } from "../../src/infrastructure/logging/Logger.js";
import { validEnv } from "./config-fixture.js";

export function initContext(
  overrides: Record<string, string | undefined> = {},
): InitContext {
  return {
    config: loadConfig(validEnv(overrides)),
    logger: createLogger({ sink: silentSink }),
    clock: systemClock,
    container: new Container(),
  };
}
