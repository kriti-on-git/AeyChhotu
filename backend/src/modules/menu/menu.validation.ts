/* Menu module — request validators.

   Moved verbatim from validation/schemas.ts so the module owns its contract;
   schemas.ts re-exports these names, keeping every existing import working. */

import { z } from "zod";
import { tableToken, uuid } from "../../validation/primitives.js";

const pagination = {
  page: z.coerce.number().int().min(1, "page must be an integer >= 1.").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, "limit must be between 1 and 100.")
    .max(100, "limit must be between 1 and 100.")
    .default(20),
};

/** E3 GET /api/v1/menu?table_token=… */
export const menuQuerySchema = z.object({
  table_token: tableToken,
  category: z.string().max(80, "Category filter must be 80 characters or fewer.").optional(),
  q: z.string().max(50, "Search query must be 50 characters or fewer.").optional(),
  ...pagination,
});

export const menuItemParamsSchema = z.object({ menu_item_id: uuid("menu_item_id") });

/** E14 PATCH /api/v1/menu/items/:menu_item_id/availability */
export const availabilitySchema = z.object({ is_available: z.boolean() });

/** GET /api/v1/menu/items/:menu_item_id/image/:size — public dish photo. */
export const menuImageParamsSchema = z.object({
  menu_item_id: uuid("menu_item_id"),
  size: z.enum(["original", "small", "tiny"]),
});

const adminDishName = z
  .string()
  .trim()
  .min(1, "Give the dish a name.")
  .max(120, "Dish names must be 120 characters or fewer.");

/* Pricing contract: a finite, non-negative amount up to the admin ceiling.
   numeric(10,2) does the storage rounding; the API refuses nonsensical money
   before it reaches SQL. */
const adminDishPrice = z.coerce
  .number()
  .finite("Price must be a number.")
  .min(0, "Price cannot be negative.")
  .max(1_000_000, "Price is unrealistically high.");

const adminDishCategory = z
  .string()
  .trim()
  .min(1, "Pick a category.")
  .max(80, "Categories must be 80 characters or fewer.");

const adminDishDescription = z
  .string()
  .trim()
  .max(500, "Descriptions must be 500 characters or fewer.");

const menuIngredients = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Ingredients cannot be empty.")
      .max(80, "Ingredients must be 80 characters or fewer."),
  )
  .max(40, "List at most 40 ingredients.");

const menuSpiceLevel = z.coerce
  .number()
  .int()
  .min(0, "Spice level must be 0 (mild) to 3 (very hot).")
  .max(3, "Spice level must be 0 (mild) to 3 (very hot).");

const menuAllergens = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Allergens cannot be empty.")
      .max(40, "Allergens must be 40 characters or fewer."),
  )
  .max(20, "List at most 20 allergen families.");

const menuDietTags = z.array(z.enum(["jain", "vegan", "halal", "eggitarian"])).max(8);

const menuPortionDescription = z
  .string()
  .trim()
  .max(80, "Portion descriptions must be 80 characters or fewer.");

/** POST /api/v1/admin/menu */
export const adminCreateMenuItemSchema = z.object({
  name: adminDishName,
  price: adminDishPrice,
  category_id: uuid("category_id").nullable().optional(),
  category: adminDishCategory.optional(),
  description: adminDishDescription.default(""),
  vegetarian: z.boolean().default(true),
  is_available: z.boolean().default(true),
  ingredients: menuIngredients.default([]),
  spice_level: menuSpiceLevel.default(0),
  allergens: menuAllergens.default([]),
  diet_tags: menuDietTags.default([]),
  portion_description: menuPortionDescription.default(""),
});

/** PATCH /api/v1/admin/menu/:menu_item_id — all fields optional, one required. */
export const adminUpdateMenuItemSchema = z
  .object({
    name: adminDishName.optional(),
    price: adminDishPrice.optional(),
    category_id: uuid("category_id").nullable().optional(),
    category: adminDishCategory.optional(),
    description: adminDishDescription.optional(),
    vegetarian: z.boolean().optional(),
    is_available: z.boolean().optional(),
    ingredients: menuIngredients.optional(),
    spice_level: menuSpiceLevel.optional(),
    allergens: menuAllergens.optional(),
    diet_tags: menuDietTags.optional(),
    portion_description: menuPortionDescription.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

export const adminMenuItemParamsSchema = z.object({ menu_item_id: uuid("menu_item_id") });

/** POST /api/v1/admin/categories */
export const adminCreateCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the folder a name.")
    .max(60, "Folder names must be 60 characters or fewer."),
  parent_id: uuid("parent_id").nullable().optional(),
});

/** PATCH /api/v1/admin/categories/:category_id */
export const adminUpdateCategorySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "The folder name cannot be empty.")
      .max(60, "Folder names must be 60 characters or fewer.")
      .optional(),
    parent_id: uuid("parent_id").nullable().optional(),
    sort_order: z.coerce.number().int().min(0).max(100_000).optional(),
    thumbnail_menu_item_id: uuid("thumbnail_menu_item_id").nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

export const adminCategoryParamsSchema = z.object({ category_id: uuid("category_id") });
