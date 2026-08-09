/**
 * Vetroscope activity-category taxonomy — mirrors the app's
 * `electron/categories/taxonomy.ts` (coding / creative / …).
 * Used by get_category_breakdown + list_categories. When the local DB
 * has `ai_app_categories` / `ai_category_meta` (Vetroscope with AI
 * categories), resolution prefers those tables; otherwise apps fall
 * through to `other`.
 */

export type ActivityCategoryId =
  | "coding"
  | "creative"
  | "productivity"
  | "communication"
  | "entertainment"
  | "music"
  | "gaming"
  | "browsing"
  | "system"
  | "other";

export interface CategoryMeta {
  id: ActivityCategoryId;
  label: string;
  color: string;
  sortOrder: number;
}

export const CATEGORY_TAXONOMY: readonly CategoryMeta[] = [
  { id: "coding", label: "Coding & Development", color: "#3B82F6", sortOrder: 10 },
  { id: "creative", label: "Creative", color: "#F97316", sortOrder: 20 },
  { id: "productivity", label: "Productivity", color: "#8B5CF6", sortOrder: 30 },
  { id: "communication", label: "Communication", color: "#14B8A6", sortOrder: 40 },
  { id: "entertainment", label: "Entertainment", color: "#EC4899", sortOrder: 50 },
  { id: "music", label: "Music", color: "#22C55E", sortOrder: 60 },
  { id: "gaming", label: "Gaming", color: "#EF4444", sortOrder: 70 },
  { id: "browsing", label: "Browsing", color: "#64748B", sortOrder: 80 },
  { id: "system", label: "System", color: "#78716C", sortOrder: 90 },
  { id: "other", label: "Other", color: "#6B7280", sortOrder: 100 },
] as const;

const BY_ID = new Map(CATEGORY_TAXONOMY.map((c) => [c.id, c]));

export function isCategoryId(value: string): value is ActivityCategoryId {
  return BY_ID.has(value as ActivityCategoryId);
}

export function getCategoryMeta(id: string): CategoryMeta {
  return BY_ID.get(id as ActivityCategoryId) ?? BY_ID.get("other")!;
}

/** @deprecated Alias kept for older call sites — prefer ActivityCategoryId. */
export type AppCategory = ActivityCategoryId;

/** @deprecated Prefer getCategoryMeta(id).label */
export const CATEGORY_LABELS: Record<ActivityCategoryId, string> = Object.fromEntries(
  CATEGORY_TAXONOMY.map((c) => [c.id, c.label]),
) as Record<ActivityCategoryId, string>;
