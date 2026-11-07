/* Menu module — repository.

   Every catalogue query lives here: folder tree, dish reads, dish writes,
   availability and the folder resolution the write path needs. The service
   never sees SQL or pg. Statements are a direct port of the legacy
   menu/catalog/admin code so the HTTP contract cannot drift. */

import { AppError } from "../../errors/app-error.js";
import type { DbPort } from "../../infrastructure/database/DatabaseManager.js";
import { isUniqueViolation } from "./menu.errors.js";
import type {
  CartMenuItem,
  CategoryAssignment,
  CategoryPatch,
  CategoryRecord,
  CategoryRow,
  CategoryUsage,
  MenuItemRow,
  MenuItemWriteInput,
  MenuRepositoryPort,
  PublicCategoryRow,
  SchemaPresence,
  UpdateMenuItemInput,
} from "./menu.types.js";

const MENU_COLUMNS = `mi.id,
       mi.name,
       mi.price::float8 AS price,
       mi.category,
       mi.category_id,
       mi.description,
       mi.vegetarian,
       mi.is_available,
       mi.ingredients,
       mi.spice_level,
       mi.allergens,
       mi.diet_tags,
       mi.portion_description,
       img.storage_driver,
       img.original_key,
       img.small_key,
       img.tiny_key,
       img.blur_data_url`;

const MENU_FROM = `FROM menu_items mi
  LEFT JOIN menu_item_images img ON img.menu_item_id = mi.id`;

const CATEGORY_SELECT = `
  SELECT c.id,
         c.name,
         c.parent_id,
         c.sort_order,
         c.thumbnail_menu_item_id,
         (SELECT count(*)::int
            FROM menu_items mi
           WHERE mi.category_id = c.id
             AND mi.deleted_at IS NULL) AS item_count,
         i.menu_item_id AS image_item_id,
         i.storage_driver,
         i.original_key,
         i.small_key,
         i.tiny_key,
         i.blur_data_url
    FROM menu_categories c
    LEFT JOIN menu_item_images i ON i.menu_item_id = c.thumbnail_menu_item_id`;

const SCHEMA_OBJECTS = ["menu_items", "menu_categories", "menu_item_images"] as const;

export class MenuRepository implements MenuRepositoryPort {
  private readonly db: DbPort;

  constructor(db: DbPort) {
    this.db = db;
  }

  /* --------------------------------------------------------------- dishes */

  private filterArgs(category: string | undefined, q: string | undefined) {
    const args: unknown[] = [];
    const where: string[] = [];

    if (category) {
      args.push(category);
      where.push(`mi.category = $${args.length}`);
    }
    if (q) {
      args.push(`%${q}%`);
      where.push(`mi.name ILIKE $${args.length}`);
    }
    where.push("mi.deleted_at IS NULL");

    return { args, whereSql: `WHERE ${where.join(" AND ")}` };
  }

  async countMenuItems(category: string | undefined, q: string | undefined): Promise<number> {
    const { args, whereSql } = this.filterArgs(category, q);
    const res = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM menu_items mi ${whereSql}`,
      args,
    );
    return res.rows[0]?.total ?? 0;
  }

  async listMenuItems(
    category: string | undefined,
    q: string | undefined,
    limit: number,
    offset: number,
  ): Promise<MenuItemRow[]> {
    const { args, whereSql } = this.filterArgs(category, q);
    args.push(limit, offset);

    const res = await this.db.query<MenuItemRow>(
      `SELECT ${MENU_COLUMNS}
         ${MENU_FROM}
         ${whereSql}
        ORDER BY mi.category, mi.name
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return res.rows;
  }

  async listAdminItems(): Promise<MenuItemRow[]> {
    const res = await this.db.query<MenuItemRow>(
      `SELECT ${MENU_COLUMNS}
         ${MENU_FROM}
        WHERE mi.deleted_at IS NULL
        ORDER BY mi.category, mi.name`,
    );
    return res.rows;
  }

  async findAdminItem(menuItemId: string): Promise<MenuItemRow | null> {
    const res = await this.db.query<MenuItemRow>(
      `SELECT ${MENU_COLUMNS}
         ${MENU_FROM}
        WHERE mi.id = $1 AND mi.deleted_at IS NULL`,
      [menuItemId],
    );
    return res.rows[0] ?? null;
  }

  async insertItem(input: MenuItemWriteInput, folder: CategoryAssignment): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO menu_items (
         name, price, category, category_id, description, vegetarian, is_available,
         ingredients, spice_level, allergens, diet_tags, portion_description
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.name.trim(),
        input.price,
        folder.category,
        folder.category_id,
        input.description.trim(),
        input.vegetarian,
        input.is_available,
        input.ingredients ?? [],
        input.spice_level ?? 0,
        input.allergens ?? [],
        input.diet_tags ?? [],
        (input.portion_description ?? "").trim(),
      ],
    );

    return res.rows[0]?.id ?? "";
  }

  /* COALESCE carries the patch because every column is NOT NULL and `false`,
     `0` and `""` are legitimate values that must win over the stored one. */
  async updateItem(
    menuItemId: string,
    input: UpdateMenuItemInput,
    folder: CategoryAssignment | null,
  ): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      `UPDATE menu_items
          SET name         = COALESCE($2, name),
              price        = COALESCE($3, price),
              category     = COALESCE($4, category),
              description  = COALESCE($5, description),
              vegetarian   = COALESCE($6, vegetarian),
              is_available = COALESCE($7, is_available),
              category_id  = CASE WHEN $8::boolean THEN $9 ELSE category_id END,
              ingredients        = COALESCE($10, ingredients),
              spice_level        = COALESCE($11, spice_level),
              allergens          = COALESCE($12, allergens),
              diet_tags          = COALESCE($13, diet_tags),
              portion_description = COALESCE($14, portion_description)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [
        menuItemId,
        input.name !== undefined ? input.name.trim() : null,
        input.price ?? null,
        folder ? folder.category : null,
        input.description !== undefined ? input.description.trim() : null,
        input.vegetarian ?? null,
        input.is_available ?? null,
        folder !== null,
        folder ? folder.category_id : null,
        input.ingredients ?? null,
        input.spice_level ?? null,
        input.allergens ?? null,
        input.diet_tags ?? null,
        input.portion_description !== undefined ? input.portion_description.trim() : null,
      ],
    );

    return res.rows.length > 0;
  }

  async archiveItem(menuItemId: string): Promise<{ id: string; name: string } | null> {
    const res = await this.db.query<{ id: string; name: string }>(
      `UPDATE menu_items
          SET deleted_at = now(), is_available = false
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name`,
      [menuItemId],
    );
    return res.rows[0] ?? null;
  }

  async setAvailability(
    menuItemId: string,
    isAvailable: boolean,
  ): Promise<{ id: string; name: string; is_available: boolean } | null> {
    const res = await this.db.query<{ id: string; name: string; is_available: boolean }>(
      `UPDATE menu_items
          SET is_available = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, is_available`,
      [menuItemId, isAvailable],
    );
    return res.rows[0] ?? null;
  }

  /* ------------------------------------------------------------ folders */

  async listCategories(): Promise<CategoryRow[]> {
    const res = await this.db.query<CategoryRow>(
      `${CATEGORY_SELECT}
        WHERE c.deleted_at IS NULL
        ORDER BY c.sort_order, lower(c.name)`,
    );
    return res.rows;
  }

  async listPublicCategories(): Promise<PublicCategoryRow[]> {
    const res = await this.db.query<PublicCategoryRow>(
      `SELECT id, name, parent_id, sort_order
         FROM menu_categories
        WHERE deleted_at IS NULL
        ORDER BY sort_order, lower(name)`,
    );
    return res.rows;
  }

  async findCategory(categoryId: string): Promise<CategoryRecord | null> {
    const res = await this.db.query<CategoryRecord>(
      `SELECT id, name, parent_id
         FROM menu_categories
        WHERE id = $1 AND deleted_at IS NULL`,
      [categoryId],
    );
    return res.rows[0] ?? null;
  }

  async insertCategory(name: string, parentId: string | null): Promise<string> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO menu_categories (name, parent_id, sort_order)
       VALUES (
         $1,
         $2,
         COALESCE((SELECT max(sort_order) + 1
                     FROM menu_categories
                    WHERE parent_id IS NOT DISTINCT FROM $2
                      AND deleted_at IS NULL), 0)
       )
       RETURNING id`,
      [name, parentId],
    );

    if (!res.rows[0]?.id) {
      throw new Error("menu category insert returned no id");
    }
    return res.rows[0].id;
  }

  async updateCategory(categoryId: string, patch: CategoryPatch): Promise<void> {
    await this.db.query(
      `UPDATE menu_categories
          SET name                   = COALESCE($2, name),
              parent_id              = CASE WHEN $3::boolean THEN $4 ELSE parent_id END,
              sort_order             = COALESCE($5, sort_order),
              thumbnail_menu_item_id = CASE WHEN $6::boolean THEN $7 ELSE thumbnail_menu_item_id END
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        categoryId,
        patch.name ?? null,
        patch.parent_id !== undefined,
        patch.parent_id ?? null,
        patch.sort_order ?? null,
        patch.thumbnail_menu_item_id !== undefined,
        patch.thumbnail_menu_item_id ?? null,
      ],
    );
  }

  async syncItemLabels(categoryId: string, name: string): Promise<void> {
    await this.db.query(
      `UPDATE menu_items
          SET category = $2
        WHERE category_id = $1 AND deleted_at IS NULL`,
      [categoryId, name],
    );
  }

  async categoryUsage(categoryId: string): Promise<CategoryUsage> {
    const res = await this.db.query<CategoryUsage>(
      `SELECT
         (SELECT count(*)::int
            FROM menu_categories
           WHERE parent_id = $1 AND deleted_at IS NULL) AS children,
         (SELECT count(*)::int
            FROM menu_items
           WHERE category_id = $1 AND deleted_at IS NULL) AS items`,
      [categoryId],
    );

    return { children: res.rows[0]?.children ?? 0, items: res.rows[0]?.items ?? 0 };
  }

  async archiveCategory(categoryId: string): Promise<void> {
    await this.db.query(
      `UPDATE menu_categories
          SET deleted_at = now(), thumbnail_menu_item_id = NULL
        WHERE id = $1`,
      [categoryId],
    );
  }

  async categoryWouldCycle(categoryId: string, candidateParent: string): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      `WITH RECURSIVE ancestry AS (
         SELECT id, parent_id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT c.id, c.parent_id
           FROM menu_categories c
           JOIN ancestry a ON c.id = a.parent_id
          WHERE c.deleted_at IS NULL
       )
       SELECT id FROM ancestry WHERE id = $2`,
      [candidateParent, categoryId],
    );
    return res.rows.length > 0;
  }

  async thumbnailBelongsToCategory(menuItemId: string, categoryId: string): Promise<boolean> {
    const res = await this.db.query<{ ok: boolean }>(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT c.id
           FROM menu_categories c
           JOIN subtree s ON c.parent_id = s.id
          WHERE c.deleted_at IS NULL
       )
       SELECT true AS ok
         FROM menu_items mi
        WHERE mi.id = $2
          AND mi.deleted_at IS NULL
          AND mi.category_id IN (SELECT id FROM subtree)`,
      [categoryId, menuItemId],
    );

    return res.rows.length > 0;
  }

  /* A write may carry a folder id, a legacy label, or both. A label without a
     folder is matched to a root folder case-insensitively and created when
     new, so an older client cannot create an invisible dish. */
  async resolveCategoryForWrite(input: {
    category_id?: string | null;
    category?: string;
  }): Promise<CategoryAssignment> {
    if (input.category_id) {
      const res = await this.db.query<{ id: string; name: string }>(
        "SELECT id, name FROM menu_categories WHERE id = $1 AND deleted_at IS NULL",
        [input.category_id],
      );
      const row = res.rows[0];
      if (!row) {
        throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
      }
      return { category_id: row.id, category: row.name };
    }

    const label = (input.category ?? "").trim();
    if (!label) return { category_id: null, category: "Main Course" };

    const existing = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name
         FROM menu_categories
        WHERE parent_id IS NULL
          AND deleted_at IS NULL
          AND lower(name) = lower($1)
        LIMIT 1`,
      [label],
    );
    const row = existing.rows[0];
    if (row) return { category_id: row.id, category: row.name };

    try {
      const created = await this.db.query<{ id: string; name: string }>(
        `INSERT INTO menu_categories (name)
         VALUES ($1)
         RETURNING id, name`,
        [label],
      );
      const made = created.rows[0];
      if (made) return { category_id: made.id, category: made.name };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.db.query<{ id: string; name: string }>(
          `SELECT id, name FROM menu_categories
            WHERE parent_id IS NULL AND deleted_at IS NULL AND lower(name) = lower($1)
            LIMIT 1`,
          [label],
        );
        const found = raced.rows[0];
        if (found) return { category_id: found.id, category: found.name };
      }
      throw err;
    }

    return { category_id: null, category: label };
  }

  async findCartItem(menuItemId: string): Promise<CartMenuItem | null> {
    const res = await this.db.query<CartMenuItem>(
      `SELECT id AS menu_item_id, name, is_available
         FROM menu_items
        WHERE id = $1 AND deleted_at IS NULL`,
      [menuItemId],
    );
    return res.rows[0] ?? null;
  }

  /* -------------------------------------------------------------- health */

  async schemaObjects(): Promise<SchemaPresence> {
    const res = await this.db.query<{
      items: boolean;
      categories: boolean;
      images: boolean;
    }>(
      `SELECT to_regclass('public.menu_items') IS NOT NULL AS items,
              to_regclass('public.menu_categories') IS NOT NULL AS categories,
              to_regclass('public.menu_item_images') IS NOT NULL AS images`,
    );

    const row = res.rows[0];
    const found = [
      [SCHEMA_OBJECTS[0], row?.items === true],
      [SCHEMA_OBJECTS[1], row?.categories === true],
      [SCHEMA_OBJECTS[2], row?.images === true],
    ] as const;

    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, exists] of found) {
      if (exists) present.push(name);
      else missing.push(name);
    }
    return { present, missing };
  }
}
