/* Diet filters — a frontend-only reading of the menu.

   The contract carries exactly one vegetarian flag (lib/api/types.ts), which
   is not enough to answer the four questions an Indian guest actually asks at
   the table: is it veg, is it non-veg, does it contain egg, and is it Jain?
   So the extra categories are derived here from the dish's own words, the
   same way lib/diner/menu-atlas derives cuisines — nothing is invented and no
   new field is added to a table we do not own.

   The rules are deliberately conservative: a dish only counts as Jain when
   nothing in its name or description suggests a root vegetable, so the filter
   under-promises rather than sending an onion to a Jain table. */

import type { MenuItem } from "@/lib/api/types";

export type DietFilter = "all" | "veg" | "non-veg" | "egg" | "jain";

export interface DietOption {
  id: DietFilter;
  label: string;
}

/* "All" is a real choice, not the absence of one: a filter bar with nothing
   selected reads as broken, so the first chip is always the way back. */
export const DIET_FILTERS: DietOption[] = [
  { id: "all", label: "All" },
  { id: "veg", label: "Veg" },
  { id: "non-veg", label: "Non-veg" },
  { id: "egg", label: "Eggitarian" },
  { id: "jain", label: "Jain" },
];

const EGG_KEYWORDS = ["egg", "omelette", "bhurji", "anda", "mayonnaise", "french toast"];

/* Ingredients Jain cooking leaves out: the root vegetables, plus raw onion
   and garlic. "ginger" is included even though practice varies, so a dish is
   never claimed as Jain on a technicality. */
const ROOT_VEG_KEYWORDS = [
  "onion",
  "garlic",
  "potato",
  "aloo",
  "carrot",
  "beetroot",
  "beet",
  "radish",
  "mooli",
  "leek",
  "ginger",
  "adrak",
];

function haystack(item: Pick<MenuItem, "name" | "description" | "category">) {
  return `${item.name} ${item.description} ${item.category}`.toLowerCase();
}

export function hasEgg(item: Pick<MenuItem, "name" | "description" | "category">) {
  const text = haystack(item);
  return EGG_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function isJain(item: Pick<MenuItem, "name" | "description" | "category" | "vegetarian">) {
  if (!item.vegetarian || hasEgg(item)) return false;
  const text = haystack(item);
  return !ROOT_VEG_KEYWORDS.some((keyword) => text.includes(keyword));
}

/** Does this dish belong under the active filter? "all" always matches. */
export function matchesDiet(item: MenuItem, filter: DietFilter): boolean {
  switch (filter) {
    case "veg":
      return item.vegetarian && !hasEgg(item);
    case "non-veg":
      return !item.vegetarian;
    case "egg":
      return hasEgg(item);
    case "jain":
      return isJain(item);
    case "all":
      return true;
  }
}
