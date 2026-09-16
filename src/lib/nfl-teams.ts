/**
 * NFL club identity -- the logo and the colours -- keyed by the same
 * abbreviations the rest of the app uses.
 *
 * The `nfl_teams` table has a `logo_url` column, but nothing populates
 * it: the nflverse feeds carry rosters and stats, not artwork. Rather
 * than add an ingestion job for thirty-two files that change once a
 * decade, the URL is derived. ESPN serves them from a stable path, and
 * their abbreviations differ from nflverse's in three places -- the
 * Rams, the Commanders and the relocated clubs -- which is what the
 * table below is for.
 */

/** nflverse abbreviation -> the slug ESPN files the club's artwork under. */
const ESPN_SLUG: Record<string, string> = {
  ARI: "ari", ATL: "atl", BAL: "bal", BUF: "buf", CAR: "car", CHI: "chi",
  CIN: "cin", CLE: "cle", DAL: "dal", DEN: "den", DET: "det", GB: "gb",
  HOU: "hou", IND: "ind", JAX: "jax", KC: "kc", LA: "lar", LAC: "lac",
  LV: "lv", MIA: "mia", MIN: "min", NE: "ne", NO: "no", NYG: "nyg",
  NYJ: "nyj", PHI: "phi", PIT: "pit", SEA: "sea", SF: "sf", TB: "tb",
  TEN: "ten", WAS: "wsh",

  // Abbreviations other feeds use for the same clubs, so a stat line
  // ingested from somewhere else still finds a crest.
  LAR: "lar", WSH: "wsh", JAC: "jax", OAK: "lv", SD: "lac", STL: "lar",
  ARZ: "ari", BLT: "bal", CLV: "cle", HST: "hou",
};

/**
 * A club's logo, or null for a player who is not on a roster -- which
 * the UI shows as a free-agent badge rather than a broken image.
 */
export function nflLogoUrl(abbr: string | null | undefined): string | null {
  if (!abbr) return null;
  const slug = ESPN_SLUG[abbr.toUpperCase()];
  return slug ? `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png` : null;
}

/** True for an abbreviation we can actually draw. */
export function isKnownNflTeam(abbr: string | null | undefined): boolean {
  return nflLogoUrl(abbr) !== null;
}
