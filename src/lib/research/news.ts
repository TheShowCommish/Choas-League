import "server-only";

/**
 * Player news, from ESPN's public site API.
 *
 * ESPN rather than Sleeper for this half of the job: we already store
 * espn_id on every player, so there is no mapping to build, and their
 * news feed carries real articles rather than one-line blurbs.
 *
 * ## Why not the obvious endpoint
 *
 * The league news feed takes an `athlete` query parameter and ignores
 * it. Asked for Patrick Mahomes it returns the same ten league-wide
 * headlines it returns for everybody -- roster cut-downs, a Panthers
 * signing, a Giants trade -- which is exactly the "all NFL news" this
 * page used to show under a player's name.
 *
 * The athlete *overview* endpoint is the one that actually knows who it
 * is being asked about. It carries the player's own articles, and a
 * Rotowire blurb, which is the short "he is on track for week one" note
 * a fantasy manager is really after.
 *
 * Undocumented and unofficial, so a failure here is never allowed to
 * take a page down -- the player page renders perfectly well with no
 * news on it.
 */

const OVERVIEW =
  "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes";

export interface NewsItem {
  id: string;
  headline: string;
  description: string;
  published: string | null;
  url: string | null;
}

/**
 * Rotowire's take: one paragraph on what happened and what it means for
 * the player's availability. The closest thing any free feed has to an
 * answer for "how long is he out".
 */
export interface PlayerBlurb {
  headline: string;
  story: string;
  published: string | null;
}

export interface PlayerResearch {
  news: NewsItem[];
  blurb: PlayerBlurb | null;
}

interface EspnCategory {
  type?: string;
  athleteId?: number | string;
}

interface EspnArticle {
  id?: number | string;
  headline?: string;
  description?: string;
  published?: string;
  lastModified?: string;
  categories?: EspnCategory[];
  links?: { web?: { href?: string } };
}

interface OverviewResponse {
  news?: EspnArticle[];
  rotowire?: {
    headline?: string;
    story?: string;
    description?: string;
    published?: string;
  };
}

const EMPTY: PlayerResearch = { news: [], blurb: null };

/**
 * Is this article actually about this player?
 *
 * The overview endpoint is already scoped to the athlete, so this is a
 * second line of defence rather than the filter itself: if ESPN ever
 * starts padding the list with league news, anything carrying athlete
 * categories that do not include ours is dropped. An article with no
 * athlete categories at all is kept, because plenty of genuine
 * single-player stories are tagged only by team.
 */
function isAboutPlayer(article: EspnArticle, espnId: string): boolean {
  const athletes = (article.categories ?? []).filter(
    (c) => c.type === "athlete" && c.athleteId !== undefined,
  );
  if (athletes.length === 0) return true;
  return athletes.some((c) => String(c.athleteId) === espnId);
}

/**
 * One player's news and injury blurb.
 *
 * Returns empty rather than throwing on any failure: a rate limit or a
 * shape change at ESPN's end is not worth an error page for a sidebar.
 */
export async function fetchPlayerResearch(
  espnId: string | null,
  limit = 8,
): Promise<PlayerResearch> {
  if (!espnId) return EMPTY;

  try {
    const response = await fetch(
      `${OVERVIEW}/${encodeURIComponent(espnId)}/overview`,
      {
        headers: { "User-Agent": "chaos-league" },
        next: { revalidate: 60 * 15 },
      },
    );

    if (!response.ok) return EMPTY;

    const body = (await response.json()) as OverviewResponse;

    const news = (body.news ?? [])
      .filter((article) => article.headline && isAboutPlayer(article, espnId))
      .slice(0, limit)
      .map((article, index) => ({
        id: String(article.id ?? index),
        headline: article.headline!,
        description: article.description ?? "",
        published: article.published ?? article.lastModified ?? null,
        url: article.links?.web?.href ?? null,
      }));

    const rotowire = body.rotowire;
    const blurb: PlayerBlurb | null =
      rotowire?.headline || rotowire?.story
        ? {
            headline: rotowire.headline ?? rotowire.description ?? "",
            story: rotowire.story ?? "",
            // Rotowire dates come through as "Sat Aug 29 10:08:09 PDT
            // 2026", which Date can parse but the timezone name makes
            // unreliable. Kept as given and only ever shown as text.
            published: rotowire.published ?? null,
          }
        : null;

    return { news, blurb };
  } catch {
    // Network trouble, a shape change, a rate limit -- none of it is
    // worth an error page for a sidebar of headlines.
    return EMPTY;
  }
}

/** The news half on its own, for callers that want nothing else. */
export async function fetchPlayerNews(
  espnId: string | null,
  limit = 5,
): Promise<NewsItem[]> {
  const { news } = await fetchPlayerResearch(espnId, limit);
  return news;
}
