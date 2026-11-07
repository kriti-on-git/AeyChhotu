/* Menu module's DI tokens, kept beside the module so the foundation token
   catalog stays free of business knowledge. */

import { createToken } from "../../bootstrap/Container.js";
import type { MenuServicePort } from "./menu.types.js";

export const MENU_TOKENS = {
  service: createToken<MenuServicePort>("menu.service"),
} as const;
