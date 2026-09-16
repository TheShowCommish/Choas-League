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
import { STAT_APPLIES_TO, STAT_CATALOG } from "../src/lib/stats/catalog.ts";

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
  `${q(s.appliesTo)}, ${q(s.valueType)}, ${s.defaultPoints}, ${s.scorable}, ` +
  `${q(s.source)}, ${s.tracked}, ${(i + 1) * 10})`,
).join(",\n");

const sql = `-- =====================================================================
-- 0010  Stat definition catalog  (GENERATED FILE -- DO NOT EDIT BY HAND)
--
-- Regenerate with:  npm run gen:stat-seed
-- Source of truth:  src/lib/stats/catalog.ts
--
-- ${STAT_CATALOG.length} stats across ${new Set(STAT_CATALOG.map((s) => s.category)).size} categories.
-- ${STAT_CATALOG.filter((s) => s.tracked).length} are populated by the
-- ingestion jobs today; the rest need play-by-play aggregation.
-- =====================================================================

-- The constraint has to admit what this file is about to insert.
--
-- It is asserted here rather than in whichever migration introduced a
-- new applies_to value, because this file is re-run out of order --
-- \`db:push --redo 0010\` runs it before every later migration -- so a
-- constraint widened in a later migration would arrive too late to help.
-- Emitted from STAT_APPLIES_TO, so it cannot drift from the catalog.
alter table public.stat_definitions
  drop constraint if exists stat_definitions_applies_to_check;
alter table public.stat_definitions
  add constraint stat_definitions_applies_to_check
  check (applies_to in (${STAT_APPLIES_TO.map(q).join(", ")}));

insert into public.stat_definitions
  (key, label, category, description, applies_to, value_type, default_points,
   scorable, source, tracked, sort_order)
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
  source         = excluded.source,
  tracked        = excluded.tracked,
  sort_order     = excluded.sort_order;

-- Remove stats that have been dropped from the catalog.
delete from public.stat_definitions
where key not in (${STAT_CATALOG.map((s) => q(s.key)).join(", ")});

-- Give every existing league a rule for whatever was just added.
--
-- seed_default_scoring_rules only runs when a league is created, so
-- without this a stat added to the catalog today would reach new
-- leagues and no others -- see 0033. Doing it here means re-running
-- this file is all a catalog change ever needs.
--
-- Only missing base rules are inserted: a commissioner who has already
-- set a value, zero included, keeps it, and per-position overrides are
-- left alone.
insert into public.league_scoring_rules (league_id, stat_key, points, positions)
select l.id, d.key, d.default_points, '{}'::text[]
from public.leagues l
cross join public.stat_definitions d
where d.scorable
  and not exists (
    select 1 from public.league_scoring_rules r
    where r.league_id = l.id
      and r.stat_key = d.key
      and cardinality(r.positions) = 0
  );
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, sql, "utf8");
console.log(
  `Wrote ${outFile} with ${STAT_CATALOG.length} stat definitions.`,
);
