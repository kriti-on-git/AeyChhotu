/* Small shared helpers used by every controller. */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

/** docs/7 §1.5 pagination envelope. */
export function buildMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, total_pages: Math.ceil(total / limit) };
}

/** Postgres timestamptz → ISO-8601 "…Z" string per docs/7 §1.2. */
export function iso(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
