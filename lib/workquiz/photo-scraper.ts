const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_CONCURRENCY = 6;
const CACHE_TTL_MS = 10 * 60 * 1000;

export type PhotoSuggestionStatus = "found" | "not_found" | "error";

export interface PhotoSuggestion {
  name: string;
  status: PhotoSuggestionStatus;
  imageUrl?: string;
  thumbnailUrl?: string;
  sourcePageUrl?: string;
  confidence: number;
  reason: string;
}

interface WikimediaImageInfo {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
}

interface WikimediaPage {
  title?: string;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaQueryResponse {
  query?: {
    pages?: Record<string, WikimediaPage>;
  };
}

type FetchLike = typeof fetch;

const suggestionCache = new Map<string, { expiresAt: number; suggestion: PhotoSuggestion }>();

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function buildSearchTerm(name: string) {
  return normalizeName(name).replace(/["']/g, "");
}

function parseFileTitle(title: string) {
  return title
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase();
}

export function scoreWikimediaTitleMatch(name: string, title: string) {
  const normalizedName = normalizeName(name).toLowerCase();
  const normalizedTitle = parseFileTitle(title);
  const nameTokens = normalizedName.split(/\s+/).filter((token) => token.length >= 2);
  if (!nameTokens.length) {
    return 0;
  }

  let matchedTokens = 0;
  for (const token of nameTokens) {
    if (normalizedTitle.includes(token)) {
      matchedTokens += 1;
    }
  }

  const tokenCoverage = matchedTokens / nameTokens.length;
  const fullNameBonus = normalizedTitle.includes(normalizedName) ? 0.15 : 0;
  return Math.min(1, tokenCoverage + fullNameBonus);
}

function toConfidenceLabel(score: number) {
  if (score >= 0.9) {
    return "high";
  }
  if (score >= 0.6) {
    return "medium";
  }
  return "low";
}

async function fetchWithTimeout(url: URL, timeoutMs: number, fetchImpl: FetchLike) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSuggestionForName(
  name: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<PhotoSuggestion> {
  const cacheKey = normalizeName(name).toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.suggestion;
  }

  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: buildSearchTerm(name),
    gsrnamespace: "6",
    gsrlimit: "6",
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: "320",
    format: "json",
    origin: "*",
  });

  const url = new URL(WIKIMEDIA_API);
  url.search = params.toString();

  try {
    const response = await fetchWithTimeout(url, timeoutMs, fetchImpl);
    if (!response.ok) {
      return {
        name,
        status: "error",
        confidence: 0,
        reason: `Wikimedia returned ${response.status}.`,
      };
    }

    const data = (await response.json()) as WikimediaQueryResponse;
    const pages = Object.values(data.query?.pages ?? {});
    if (!pages.length) {
      return {
        name,
        status: "not_found",
        confidence: 0,
        reason: "No Wikimedia image match found.",
      };
    }

    const candidates = pages
      .map((page) => {
        const imageInfo = page.imageinfo?.[0];
        const pageTitle = page.title ?? "";
        const imageUrl = imageInfo?.url;
        if (!imageUrl) {
          return null;
        }
        return {
          imageUrl,
          thumbnailUrl: imageInfo.thumburl,
          sourcePageUrl: imageInfo.descriptionurl,
          title: pageTitle,
          score: scoreWikimediaTitleMatch(name, pageTitle),
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) {
      return {
        name,
        status: "not_found",
        confidence: 0,
        reason: "No Wikimedia image match found.",
      };
    }

    const suggestion: PhotoSuggestion = {
      name,
      status: "found",
      imageUrl: best.imageUrl,
      thumbnailUrl: best.thumbnailUrl,
      sourcePageUrl: best.sourcePageUrl,
      confidence: Number(best.score.toFixed(2)),
      reason: `${toConfidenceLabel(best.score)} confidence title match`,
    };

    suggestionCache.set(cacheKey, {
      suggestion,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return suggestion;
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "Wikimedia request timed out." : "Wikimedia request failed.";
    return {
      name,
      status: "error",
      confidence: 0,
      reason: message,
    };
  }
}

export async function suggestEntrantPhotos(
  names: string[],
  options?: {
    timeoutMs?: number;
    concurrency?: number;
    fetchImpl?: FetchLike;
  },
) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_CONCURRENCY);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const normalizedNames = names.map(normalizeName);
  const results: PhotoSuggestion[] = new Array(normalizedNames.length);

  let index = 0;
  async function worker() {
    while (index < normalizedNames.length) {
      const currentIndex = index;
      index += 1;
      const name = normalizedNames[currentIndex];
      if (!name) {
        results[currentIndex] = {
          name,
          status: "error",
          confidence: 0,
          reason: "Missing entrant name.",
        };
        continue;
      }
      results[currentIndex] = await fetchSuggestionForName(name, timeoutMs, fetchImpl);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, normalizedNames.length) }, () => worker()));
  return results;
}
