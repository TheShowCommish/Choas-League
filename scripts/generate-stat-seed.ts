/**
 * Regenerates supabase/migrations/0010_seed_stat_definitions.sql from the
 * TypeScript stat catalog, so the DB catalog and the app catalog can never
 * drift apart.
 *
 *   npm run gen:stat-seed
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAT_CATALOG } from "../src/lib/stats/catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(
  here,
  "..",
  "supabase",
  "migrations",
  "0010_seed_stat_definitions.sql",
);

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const values = STAT_CATALOG.map((s, i) =>
  `  (${q(s.key)}, ${q(s.label)}, ${q(s.category)}, ${q(s.description)}, ` +
  `${q(s.appliesTo)}, ${q(s.valueType)}, ${s.defaultPoints}, ${s.scorable}, ${(i + 1) * 10})`,
).join(",\n");

const sql = `-- =====================================================================
-- 0010  Stat definition catalog  (GENERATED FILE -- DO NOT EDIT BY HAND)
--
-- Regenerate with:  npm run gen:stat-seed
-- Source of truth:  src/lib/stats/catalog.ts
--
-- ${STAT_CATALOG.length} stats across ${new Set(STAT_CATALOG.map((s) => s.category)).size} categories.
-- =====================================================================

insert into public.stat_definitions
  (key, label, category, description, applies_to, value_type, default_points, scorable, sort_order)
values
${values}
on conflict (key) do update set
  label          = excluded.label,
  category       = excluded.category,
  description    = excluded.description,
  applies_to     = excluded.applies_to,
  value_type     = excluded.value_type,
  default_points = excluded.default_points,
  scorable       = excluded.scorable,
  sort_order     = excluded.sort_order;

-- Remove stats that have been dropped from the catalog.
delete from public.stat_definitions
where key not in (${STAT_CATALOG.map((s) => q(s.key)).join(", ")});
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, sql, "utf8");
console.log(
  `Wrote ${outFile} with ${STAT_CATALOG.length} stat definitions.`,
);
