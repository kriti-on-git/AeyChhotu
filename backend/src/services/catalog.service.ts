/* Transitional facade over the Menu module's catalogue folders.

   routes/admin.ts still imports these names; keeping them here means the
   admin controller did not have to change while the implementation moved. */

import { getDefaultMenuService } from "./menu.service.js";

export type {
  CategoryAssignment,
  CategoryDto,
  CategoryPatch,
  CategoryWriteInput,
} from "../modules/menu/index.js";

export function listCategories() {
  return getDefaultMenuService().listCategories();
}

export function listPublicCategories() {
  return getDefaultMenuService().listPublicCategories();
}

export function createCategory(input: { name: string; parent_id?: string | null }) {
  return getDefaultMenuService().createCategory(input);
}

export function updateCategory(categoryId: string, input: import("../modules/menu/index.js").CategoryPatch) {
  return getDefaultMenuService().updateCategory(categoryId, input);
}

export function deleteCategory(categoryId: string) {
  return getDefaultMenuService().deleteCategory(categoryId);
}

export function resolveCategoryForWrite(input: {
  category_id?: string | null;
  category?: string;
}) {
  return getDefaultMenuService().resolveCategoryForWrite(input);
}
