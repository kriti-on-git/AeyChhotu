/* Menu atlas — the two-stage discovery layer.

   The API returns a flat list where each dish carries one `category` string.
   That is enough to group dishes but not enough to open a menu with, so this
   module arranges the SAME dishes into the shape a guest recognises:

     cuisine  →  the dish's category (straight from the data)  →  dishes

   Nothing is invented and nothing is fetched: every cuisine card's count and
   every category inside it is derived from the menu the backend already sent.
   If the backend's vocabulary moves away from the keywords below, the atlas
   degrades instead of breaking — unmatched dishes land in one honest
   "From the kitchen" group, and if only one group survives we skip the
   cuisine stage and lead with the real categories. */

import type { MenuItem } from "@/lib/api/types";

export interface MenuCategory {
  /** The category string exactly as the API sends it — never rewritten. */
  name: string;
  items: MenuItem[];
}

export interface MenuCuisine {
  id: string;
  name: string;
  /** One short line under the title, in the menu's voice. */
  tagline: string;
  categories: MenuCategory[];
  itemCount: number;
  /** A cuisine with a single category goes straight to the deck: an extra tap
      through a one-item list is friction, not discovery. */
  singleCategory: boolean;
}

export interface MenuAtlas {
  cuisines: MenuCuisine[];
  /** False when only one cuisine resolved — the browser then leads with the
      categories themselves, so unknown menus still get two real levels. */
  grouped: boolean;
}

interface CuisineRule {
  id: string;
  name: string;
  tagline: string;
  /** Matched as substrings against the dish's name + description + category. */
  keywords: string[];
}

/* Order is deliberate: the first rule a dish matches wins, so the more
   specific cuisine sits above the broader one ("tandoori" must reach North
   Indian before "rice" could claim the dish). */
const RULES: CuisineRule[] = [
  {
    id: "south-indian",
    name: "South Indian",
    tagline: "Crisp, comforting classics",
    keywords: ["dosa", "idli", "vada", "sambar", "rasam", "uttapam", "appam", "pongal", "upma"],
  },
  {
    id: "chinese",
    name: "Indo-Chinese",
    tagline: "Wok-tossed and glossy",
    keywords: ["noodle", "hakka", "chowmein", "manchurian", "schezwan", "schezwan", "spring roll", "fried rice"],
  },
  {
    id: "north-indian",
    name: "North Indian",
    tagline: "Slow gravies, hot tandoors",
    keywords: [
      "paneer",
      "butter masala",
      "tikka",
      "korma",
      "kofta",
      "dal",
      "curry",
      "naan",
      "roti",
      "kulcha",
      "paratha",
      "bread",
      "tandoor",
    ],
  },
  {
    id: "rice",
    name: "Biryani & Rice",
    tagline: "Dum-cooked, saffron, unhurried",
    keywords: ["biryani", "pulao", "pilaf", "rice"],
  },
  {
    id: "snacks",
    name: "Snacks & Starters",
    tagline: "Small plates, big appetite",
    keywords: ["pakora", "taco", "burger", "samosa", "chaat", "starter", "appetiser", "appetizer", "fries", "roll", "sandwich", "momo", "kebab"],
  },
  {
    id: "drinks-desserts",
    name: "Drinks & Desserts",
    tagline: "Something sweet to finish",
    keywords: ["lassi", "chai", "coffee", "juice", "soda", "drink", "beverage", "kulfi", "gulab", "jamun", "halwa", "payasam", "dessert", "sweet", "ice cream", "falooda"],
  },
];

const KITCHEN_CATCH_ALL: Omit<CuisineRule, "keywords"> = {
  id: "from-the-kitchen",
  name: "From the kitchen",
  tagline: "Everything else on the pass",
};

function cuisineFor(item: MenuItem): Omit<CuisineRule, "keywords"> {
  const text = `${item.name} ${item.description} ${item.category}`.toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule;
  }

  return KITCHEN_CATCH_ALL;
}

/** Arrange the API's flat menu into cuisines of categories of dishes. Order
    inside a cuisine follows the order the backend sent, so a curated menu
    keeps its running order. */
export function buildMenuAtlas(menu: MenuItem[]): MenuAtlas {
  const byCuisine = new Map<string, MenuCuisine>();

  for (const item of menu) {
    const rule = cuisineFor(item);

    const cuisine =
      byCuisine.get(rule.id) ??
      ({
        id: rule.id,
        name: rule.name,
        tagline: rule.tagline,
        categories: [],
        itemCount: 0,
        singleCategory: false,
      } satisfies MenuCuisine);

    const category = cuisine.categories.find((entry) => entry.name === item.category);
    if (category) {
      category.items.push(item);
    } else {
      cuisine.categories.push({ name: item.category, items: [item] });
    }

    cuisine.itemCount += 1;
    byCuisine.set(rule.id, cuisine);
  }

  /* The cards are ordered by the rule list, not by whichever dish happened to
     come first: the discovery grid is a curated running order, and it stays
     the same shape as the menu grows. Unmatched dishes come last. */
  const rank = new Map(RULES.map((rule, index) => [rule.id, index]));

  const cuisines = [...byCuisine.values()]
    .sort((a, b) => (rank.get(a.id) ?? RULES.length) - (rank.get(b.id) ?? RULES.length))
    .map((cuisine) => ({
      ...cuisine,
      singleCategory: cuisine.categories.length === 1,
    }));

  return { cuisines, grouped: cuisines.length > 1 };
}

/** Every dish whose words match the query — the secondary way in, for a guest
    who already knows what they want. */
export function searchMenu(menu: MenuItem[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return menu;

  return menu.filter((item) =>
    `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(needle),
  );
}
