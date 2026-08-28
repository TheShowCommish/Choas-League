import "server-only";

/**
 * Player news, from ESPN's public site API.
 *
 * ESPN rather than Sleeper for this half of the job: we already store
 * espn_id on every player, so there is no mapping to build, and their
 * news feed carries real articles rather than one-line blurbs.
 *
 * Undocumented and unofficial, so a failure here is never allowed to
 * take a page down -- the player page renders perfectly well with no
 * news on it.
 */

export interface NewsItem {
  id: string;
  headline: string;
  description: string;
  published: string | null;
  url: string | null;
}

interface EspnArticle {
  id?: number | string;
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
}

export async function fetchPlayerNews(
  espnId: string | null,
  limit = 5,
): Promise<NewsItem[]> {
  if (!espnId) return [];

  try {
    const response = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news" +
        `?athlete=${encodeURIComponent(espnId)}&limit=${limit}`,
      {
        headers: { "User-Agent": "chaos-league" },
        next: { revalidate: 60 * 30 },
      },
    );

    if (!response.ok) return [];

    const body = (await response.json()) as { articles?: EspnArticle[] };

    return (body.articles ?? [])
      .filter((article) => article.headline)
      .slice(0, limit)
      .map((article, index) => ({
        id: String(article.id ?? index),
        headline: article.headline!,
        description: article.description ?? "",
        published: article.published ?? null,
        url: article.links?.web?.href ?? null,
      }));
  } catch {
    // Network trouble, a shape change, a rate limit -- none of it is
    // worth an error page for a sidebar of headlines.
    return [];
  }
}
