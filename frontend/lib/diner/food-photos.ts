/* Dish imagery — a frontend-only presentation layer.

   The menu contract carries no image field and the database is not ours to
   change, so the photography is resolved here: a curated keyword map from the
   dish's own words (name, description, category) to a warm, plate-level photo,
   then a category-level photo, then a designed palette tile. Nothing in this
   file invents menu data — it only decides what a dish looks like.

   Every URL below was fetched once and confirmed to return 200. To swap a
   dish's photo, edit the one entry for it; to add a dish the backend grows
   later, add a keyword line and it inherits the right picture automatically. */

import type { MenuItem } from "@/lib/api/types";

/** Only this host is allowed through next/image (see next.config.ts). */
export const FOOD_PHOTO_HOST = "images.unsplash.com";

const photo = (path: string) => `https://${FOOD_PHOTO_HOST}/${path}`;

/* One photo per signature dish. Keys are matched as substrings against the
   dish's lowercased name + description + category, longest key first, so
   "butter masala" wins over "masala". */
export const DISH_PHOTOS: Record<string, string> = {
  dosa: photo("photo-1668236543090-82eba5ee5976"),
  "paneer butter masala": photo("photo-1742599361574-6fb156181466"),
  noodles: photo("photo-1789990662414-f607ba6405f3"),
  biryani: photo("photo-1631515243349-e0cb75fb8d3a"),
  "butter masala": photo("photo-1742599361574-6fb156181466"),
  taco: photo("photo-1545093149-618ce3bcf49d"),
  burger: photo("photo-1520072959219-c595dc870360"),
  pakora: photo("photo-1765360024331-25b63e85272e"),
  naan: photo("photo-1756821752957-00bfcadc3748"),
  kulcha: photo("photo-1756821752957-00bfcadc3748"),
  roti: photo("photo-1780907084884-ded9fddbb474"),
  paratha: photo("photo-1780907084884-ded9fddbb474"),
  lassi: photo("photo-1623065422902-30a2d299bbe4"),
  chai: photo("photo-1619581073186-5b4ae1b0caad"),
  kulfi: photo("photo-1772004839638-fcad4bcc2b89"),
  "ice cream": photo("photo-1772004839638-fcad4bcc2b89"),
};

/* Category-level photography: the safety net for any dish the map above does
   not know, so a growing backend menu is never photo-less. */
const CATEGORY_PHOTOS: Record<string, string> = {
  bread: photo("photo-1680359939304-7e27ee183e7a"),
  drink: photo("photo-1636920272028-c27f1ae474c3"),
  beverage: photo("photo-1636920272028-c27f1ae474c3"),
  dessert: photo("photo-1695568181363-af5c78f4d059"),
  sweet: photo("photo-1695568181363-af5c78f4d059"),
  starter: photo("photo-1775717430472-bac0b07e90e3"),
  appetiser: photo("photo-1775717430472-bac0b07e90e3"),
  appetizer: photo("photo-1775717430472-bac0b07e90e3"),
  main: photo("photo-1767114915936-745dd372f1d8"),
  rice: photo("photo-1631515243349-e0cb75fb8d3a"),
};

const KEYS_BY_LENGTH = Object.keys(DISH_PHOTOS).sort((a, b) => b.length - a.length);

function haystack(item: Pick<MenuItem, "name" | "description" | "category">) {
  return `${item.name} ${item.description} ${item.category}`.toLowerCase();
}

/** The best photo for a dish, or null when the curated map has nothing. */
export function resolveDishPhoto(item: Pick<MenuItem, "name" | "description" | "category">) {
  const text = haystack(item);

  for (const key of KEYS_BY_LENGTH) {
    if (text.includes(key)) {
      const match = DISH_PHOTOS[key];
      if (match) return match;
    }
  }

  for (const [key, url] of Object.entries(CATEGORY_PHOTOS)) {
    if (text.includes(key)) return url;
  }

  return null;
}

/** Stable alt text: the photo is decoration next to the dish name, but a
    screen reader still deserves to know what the image is. */
export function dishPhotoAlt(item: Pick<MenuItem, "name">) {
  return `${item.name}, as served in the restaurant`;
}

/* ---- Fallback tile -------------------------------------------------------
   If the network is unavailable (the demo store runs offline on purpose) the
   optimiser request fails and the card falls back to this: a warm two-stop
   wash picked from the dish's own key, so two cards never look like a
   loading error and the palette never leaves the brand. */

const FALLBACK_WASHES = [
  "from-ember-soft via-beige to-tan/60",
  "from-beige via-sand to-tan/70",
  "from-sand via-beige to-ember-soft",
  "from-tan/50 via-beige to-cream",
] as const;

export function dishFallbackWash(item: Pick<MenuItem, "id" | "name">) {
  const seed = `${item.id}${item.name}`.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return FALLBACK_WASHES[seed % FALLBACK_WASHES.length] ?? FALLBACK_WASHES[0];
}
