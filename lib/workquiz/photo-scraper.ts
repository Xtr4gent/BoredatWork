const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const SERPER_API = "https://google.serper.dev/images";
const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_CONCURRENCY = 6;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SERPER_RESULTS = 5;
const MIN_SERPER_SCORE = 0.55;
const MIN_SERPER_IMAGE_DIMENSION = 200;
const SERPER_REJECTED_TITLE_HINTS = [
  "logo",
  "wallpaper",
  "meme",
  "clipart",
  "sticker",
  "vector",
  "svg",
  "emoji",
];

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

interface SerperImageResult {
  imageUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  source?: string;
  link?: string;
  imageWidth?: number;
  imageHeight?: number;
}

interface SerperImageResponse {
  images?: SerperImageResult[];
}

type FetchLike = typeof fetch;

const suggestionCache = new Map<string, { expiresAt: number; suggestion: PhotoSuggestion }>();

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function buildSearchTerm(name: string) {
  return normalizeName(name).replace(/["']/g, "");
}

function buildSerperSearchTerm(name: string, variant: "default" | "alt") {
  const base = buildSearchTerm(name);
  if (variant === "alt") {
    return `${base} portrait photo`;
  }
  return base;
}

function parseFileTitle(title: string) {
  return title
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase();
}

function scoreTextMatch(name: string, candidateText: string) {
  const normalizedName = normalizeName(name).toLowerCase();
  const normalizedCandidate = candidateText.toLowerCase();
  const nameTokens = normalizedName.split(/\s+/).filter((token) => token.length >= 2);
  if (!nameTokens.length) {
    return 0;
  }

  let matchedTokens = 0;
  for (const token of nameTokens) {
    if (normalizedCandidate.includes(token)) {
      matchedTokens += 1;
    }
  }

  const tokenCoverage = matchedTokens / nameTokens.length;
  const fullNameBonus = normalizedCandidate.includes(normalizedName) ? 0.15 : 0;
  return Math.min(1, tokenCoverage + fullNameBonus);
}

export function scoreWikimediaTitleMatch(name: string, title: string) {
  return scoreTextMatch(name, parseFileTitle(title));
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

function scoreSerperResult(name: string, result: SerperImageResult) {
  const combinedText = `${result.title ?? ""} ${result.source ?? ""}`;
  return scoreTextMatch(name, combinedText);
}

function isRejectedSerperResult(result: SerperImageResult) {
  const combinedText = `${result.title ?? ""} ${result.source ?? ""}`.toLowerCase();
  if (SERPER_REJECTED_TITLE_HINTS.some((hint) => combinedText.includes(hint))) {
    return true;
  }

  if (
    typeof result.imageWidth === "number" &&
    typeof result.imageHeight === "number" &&
    (result.imageWidth < MIN_SERPER_IMAGE_DIMENSION || result.imageHeight < MIN_SERPER_IMAGE_DIMENSION)
  ) {
    return true;
  }

  return false;
}

async function fetchWithTimeout(
  input: URL | string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  init?: RequestInit,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSerperSuggestionForName(
  name: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  serperApiKey: string,
  gl: string,
  hl: string,
  searchVariant: "default" | "alt",
): Promise<PhotoSuggestion> {
  try {
    const response = await fetchWithTimeout(SERPER_API, timeoutMs, fetchImpl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": serperApiKey,
      },
      body: JSON.stringify({
        q: buildSerperSearchTerm(name, searchVariant),
        gl,
        hl,
        num: DEFAULT_SERPER_RESULTS,
      }),
    });
    if (!response.ok) {
      return {
        name,
        status: "error",
        confidence: 0,
        reason: `Serper returned ${response.status}.`,
      };
    }

    const data = (await response.json()) as SerperImageResponse;
    const candidates = (data.images ?? [])
      .map((image) => {
        if (!image.imageUrl) {
          return null;
        }
        if (isRejectedSerperResult(image)) {
          return null;
        }
        const score = scoreSerperResult(name, image);
        if (score < MIN_SERPER_SCORE) {
          return null;
        }
        return {
          imageUrl: image.imageUrl,
          thumbnailUrl: image.thumbnailUrl,
          sourcePageUrl: image.link,
          score,
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
        reason: "No Google image match found.",
      };
    }

    return {
      name,
      status: "found",
      imageUrl: best.imageUrl,
      thumbnailUrl: best.thumbnailUrl,
      sourcePageUrl: best.sourcePageUrl,
      confidence: Number(best.score.toFixed(2)),
      reason: `${toConfidenceLabel(best.score)} confidence Google match`,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Serper request timed out."
        : "Serper request failed.";
    return {
      name,
      status: "error",
      confidence: 0,
      reason: message,
    };
  }
}

async function fetchSuggestionForName(
  name: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  options?: {
    serperApiKey?: string | null;
    serperGl?: string;
    serperHl?: string;
    skipCache?: boolean;
    searchVariant?: "default" | "alt";
  },
): Promise<PhotoSuggestion> {
  const cacheKey = normalizeName(name).toLowerCase();
  if (!options?.skipCache) {
    const cached = suggestionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.suggestion;
    }
  }

  const serperApiKey = options?.serperApiKey ?? process.env.SERPER_API_KEY ?? null;
  if (serperApiKey) {
    const serperSuggestion = await fetchSerperSuggestionForName(
      name,
      timeoutMs,
      fetchImpl,
      serperApiKey,
      options?.serperGl ?? process.env.SERPER_GL ?? "us",
      options?.serperHl ?? process.env.SERPER_HL ?? "en",
      options?.searchVariant ?? "default",
    );
    if (serperSuggestion.status === "found") {
      suggestionCache.set(cacheKey, {
        suggestion: serperSuggestion,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return serperSuggestion;
    }
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
    serperApiKey?: string | null;
    serperGl?: string;
    serperHl?: string;
    skipCache?: boolean;
    searchVariant?: "default" | "alt";
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
      results[currentIndex] = await fetchSuggestionForName(name, timeoutMs, fetchImpl, options);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, normalizedNames.length) }, () => worker()));
  return results;
}
