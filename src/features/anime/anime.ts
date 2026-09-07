import { encodeMochiUrl } from "../../core/runtime/utils.ts";
import { cacheKey } from "../../core/runtime/cacheNamespace.ts";
import { catalogMatchRank, normalizeCatalogText } from "../games/catalogSearch.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import {
  appendMegaPlayParams,
  mergeAnimeIds,
  normalizeAnimeIds,
  resetAnimeIdentityCache,
  type AnimeIds,
} from "./animeIdentity.ts";

export interface AnimeEntry {
  id: string | number;
  title: string;
  year?: number | undefined;
  posterUrl: string;
  posterSmallUrl?: string | undefined;
  backdropUrl?: string | undefined;
  rating?: number | undefined;
  overview?: string | undefined;
  animeType: "anime";
  genres?: string[] | undefined;
  adult?: boolean | undefined;
  category?: AnimeEntryCategory | undefined;
   
  ids?: AnimeIds | undefined;
  seasons?: AnimeSeason[] | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | undefined;
  _normalizedTitle?: string | undefined;
  _searchText?: string | undefined;
  _relatedAnimeIds?: string[] | undefined;
  _relatedSeasonEntries?: AnimeSeason[] | undefined;
}

type AnimeEntryCategory =
  | "main-season"
  | "movie"
  | "ova"
  | "ona"
  | "special"
  | "recap"
  | "spin-off"
  | "side-story"
  | "music"
  | "unknown";

interface AnimeSeasonPart {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  episodeCount?: number | undefined;
}

export interface AnimeSeason {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  category?: AnimeEntryCategory | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | undefined;
  relationType?: string | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export type AnimeCategory = "trending" | "anime";

export function isAnimeMovieFormat(format?: string): boolean {
  const normalized = format?.trim().toUpperCase();
  return normalized === "MOVIE" || normalized === "MUSIC";
}

export function shouldBlockAnimeSeasonPicker(
  hasMalId: boolean,
  seasonCount: number,
  incompleteMetadata = false,
): boolean {
  return hasMalId && (seasonCount < 2 || incompleteMetadata);
}

function classifyAnimeCategory(
  format?: string,
  title = "",
  relationType?: string,
): AnimeEntryCategory {
  const normalizedFormat = format?.trim().toUpperCase();
  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedRelation = relationType
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[-_]+/g, " ");

  if (normalizedFormat === "MOVIE") return "movie";
  if (normalizedFormat === "MUSIC") return "music";
  if (normalizedFormat === "OVA" || normalizedFormat === "OAD") return "ova";
  if (normalizedFormat === "ONA") return "ona";
  if (
    normalizedFormat === "SPECIAL" ||
    /\b(?:special|recap|summary|digest|kanwa)\b/.test(normalizedTitle)
  ) {
    return /\b(?:recap|summary|digest)\b/.test(normalizedTitle)
      ? "recap"
      : "special";
  }
  if (/\b(?:movie|gekijouban|film)\b/.test(normalizedTitle)) return "movie";
  if (/\b(?:ova|oad)\b/.test(normalizedTitle)) return "ova";
  if (/\bona\b/.test(normalizedTitle)) return "ona";
  if (normalizedRelation === "spin off") return "spin-off";
  if (normalizedRelation === "side story") return "side-story";
  if (normalizedFormat === "TV" || normalizedFormat === "TV_SHORT") {
    return "main-season";
  }
  if (
    normalizedRelation === "prequel" ||
    normalizedRelation === "sequel"
  ) {
    return "main-season";
  }
  return "unknown";
}

 
function normalizeAnimeRating(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const score = parsed > 10 ? parsed / 10 : parsed;
  if (!Number.isFinite(score) || score <= 0) return undefined;
  return Math.round(Math.min(10, score) * 10) / 10;
}

export function episodeNumbersForCount(
  maxEpisode: number,
  initialEpisode = 0,
): number[] {
  const count = Math.max(maxEpisode || 0, initialEpisode || 0);
  return count > 0
    ? Array.from({ length: count }, (_, index) => index + 1)
    : [];
}

export interface AnimePlaybackUrlOptions {
  title: string;
  posterUrl: string;
  ids?: AnimeIds | undefined;
  episode: number;
  sourceEpisode?: number | undefined;
  episodeCount?: number | undefined;
  year?: number | undefined;
  format?: string | undefined;
  language?: "sub" | "dub" | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export function buildAnimePlaybackUrl({
  title,
  posterUrl,
  ids,
  episode,
  sourceEpisode,
  episodeCount,
  year,
  format,
  language = "sub",
  parts,
}: AnimePlaybackUrlOptions): string {
  const params = new URLSearchParams({
    title,
    poster: posterUrl,
    episode: String(episode),
    episodeName: `E${episode}`,
    language,
  });
  appendMegaPlayParams(params, ids);
  if (sourceEpisode && sourceEpisode > 0 && sourceEpisode !== episode) {
    params.set("source_episode", String(sourceEpisode));
  }
  if (parts && parts.length > 1) {
    let start = 1;
    const ranges = parts.flatMap((part) => {
      const count = part.episodeCount || 0;
      if (count <= 0) return [];
      const range = { start, end: start + count - 1, ids: part.ids };
      start += count;
      return [range];
    });
    if (ranges.length > 1) params.set("episode_parts", JSON.stringify(ranges));
  }
  if (year) params.set("year", String(year));
  if (episodeCount && episodeCount > 0) {
    params.set("episode_count", String(episodeCount));
  }
  if (format) params.set("format", format);
  return `/stream/anime?${params.toString()}`;
}

function deriveAniListEpisodeCount(
  media: Pick<AniListMedia, "episodes" | "status" | "nextAiringEpisode">,
): { count?: number; source?: "anilist" | "anilistAiring" } {
  const nextEpisode = media.nextAiringEpisode?.episode;
  if (Number.isInteger(nextEpisode) && (nextEpisode || 0) > 1) {
    return { count: (nextEpisode || 0) - 1, source: "anilistAiring" };
  }
  if (media.nextAiringEpisode) return {};
  if (Number.isInteger(media.episodes) && (media.episodes || 0) > 0) {
    return { count: media.episodes || 0, source: "anilist" };
  }
  return {};
}

function deriveAnikotoEpisodeCount(record: {
  episodes?: number | string;
  next_air_ep?: number | string | null;
  status?: string;
}): {
  count?: number;
  source?: "anikoto" | "anikotoAiring";
} {
  const nextEpisode = Number(record.next_air_ep);
  if (Number.isInteger(nextEpisode) && nextEpisode > 1) {
    return { count: nextEpisode - 1, source: "anikotoAiring" };
  }
  if (record.next_air_ep != null) return {};
  const count = Number(record.episodes);
  if (Number.isInteger(count) && count > 0) {
    return { count, source: "anikoto" };
  }
  return {};
}

interface AniListMedia {
  id: number;
  idMal?: number;
  title: { english?: string; romaji?: string; native?: string };
  coverImage: { large?: string; medium?: string };
  averageScore?: number;
  seasonYear?: number;
  isAdult?: boolean;
  format?: string;
  status?: string;
  episodes?: number;
  nextAiringEpisode?: { episode?: number };
  relations?: {
    edges?: Array<{
      relationType?: string;
      node?: AniListMedia;
    }>;
  };
}

interface AniListResponse {
  data?: { Page?: { media?: AniListMedia[] } };
}

interface KitsuAnimeResource {
  id: string;
  attributes?: {
    canonicalTitle?: string;
    titles?: Record<string, string>;
    startDate?: string;
    subtype?: string;
    averageRating?: string;
    episodeCount?: number;
    posterImage?: { large?: string; medium?: string };
  };
  relationships?: {
    mappings?: { data?: Array<{ id: string }> };
  };
}

interface KitsuMappingResource {
  id: string;
  attributes?: {
    externalSite?: string;
    externalId?: string;
  };
}

interface KitsuAnimeResponse {
  data?: KitsuAnimeResource[];
  included?: KitsuMappingResource[];
}

function kitsuResourceToAnime(
  resource: KitsuAnimeResource,
  mappings: Map<string, KitsuMappingResource>,
): AnimeEntry | null {
  const attributes = resource.attributes;
  const poster =
    attributes?.posterImage?.large || attributes?.posterImage?.medium || "";
  if (!poster) return null;
  const titles = attributes?.titles || {};
  const title =
    titles.en ||
    titles.en_us ||
    attributes?.canonicalTitle ||
    titles.en_jp ||
    titles.ja_jp ||
    "unknown";
  const year = Number.parseInt(attributes?.startDate?.slice(0, 4) || "", 10);
  const rating = Number.parseFloat(attributes?.averageRating || "");
  const ids = normalizeAnimeIds({ kitsu: resource.id });
  for (const mappingRef of resource.relationships?.mappings?.data || []) {
    const mapping = mappings.get(mappingRef.id);
    const site = mapping?.attributes?.externalSite?.toLowerCase();
    const id = mapping?.attributes?.externalId;
    if (!id) continue;
    if (site === "anilist/anime") ids.anilist ||= id;
    if (site === "myanimelist/anime") ids.mal ||= id;
  }
  return {
    id: resource.id,
    title,
    year: Number.isFinite(year) ? year : undefined,
    posterUrl: `/!cover!/${encodeMochiUrl(poster)}/`,
    posterSmallUrl: attributes?.posterImage?.medium
      ? `/!cover!/${encodeMochiUrl(attributes.posterImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(rating),
    animeType: "anime",
    category: classifyAnimeCategory(attributes?.subtype, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format: attributes?.subtype?.toUpperCase(),
    episodeCount: attributes?.episodeCount,
    _episodeCountSource: attributes?.episodeCount != null ? "kitsu" : undefined,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(
      [title, titles.en, titles.en_jp, titles.ja_jp]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

async function fetchKitsuAnimeList(
  url: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }
  const json = (await response.json()) as KitsuAnimeResponse;
  const mappings = new Map(
    (json.included || []).map((mapping) => [mapping.id, mapping]),
  );
  return (json.data || [])
    .map((resource) => kitsuResourceToAnime(resource, mappings))
    .filter((entry): entry is AnimeEntry => entry !== null);
}

interface KitsuEpisodeResponse {
  data?: Array<{ attributes?: { number?: number | string } }>;
  meta?: { count?: number };
}

export interface AnimeEpisodeMapping {
  number: number;
  title?: string;
  anikotoEpisodeId?: string;
  languages: Array<"sub" | "dub">;
}

interface AnikotoAnimeRecord {
  id?: string | number;
  title?: string;
  alternative?: string;
  titles?: string;
  native?: string;
  poster?: string;
  background_image?: string;
  year?: number | string;
  episodes?: number | string;
  score?: number | string;
  status?: string;
  next_air_ep?: number | string | null;
  mal_id?: number | string;
  ani_id?: number | string;
  terms_by_type?: { type?: string[] };
}

interface AnikotoRecentResponse {
  data?: AnikotoAnimeRecord[];
}

interface AnikotoEpisodeRecord {
  number?: number | string;
  title?: string;
  episode_embed_id?: string | number;
  embed_url?: Record<string, string>;
}

interface AnikotoSeriesResponse {
  data?: { episodes?: AnikotoEpisodeRecord[] };
}

const ANILIST_URL = `/!!/${encodeMochiUrl("https://graphql.anilist.co")}/`;
const ANIKOTO_API_URL = "https://anikotoapi.site";
const KITSU_API_URL = "https://kitsu.io/api/edge";
const ANILIST_MEDIA_FIELDS = `
  id
  idMal
  title { english romaji native }
  coverImage { large medium }
  averageScore
  seasonYear
  isAdult
  format
  status
  episodes
  nextAiringEpisode { episode }
  relations {
    edges {
      relationType
      node {
        id
        idMal
        title { english romaji native }
        seasonYear
        format
        status
        episodes
        nextAiringEpisode { episode }
      }
    }
  }
`;
type AnimeFeedSubscriber = (anime: AnimeEntry[]) => void;

interface AnimeFeedRequest {
  promise: Promise<AnimeEntry[]>;
  latest: AnimeEntry[];
  subscribers: Set<AnimeFeedSubscriber>;
}

const animeFeedRequests = new Map<string, AnimeFeedRequest>();
let animeFeedGeneration = 0;
const sortedAnimePromises = new Map<string, Promise<AnimeEntry[]>>();
const searchAnimePromises = new Map<string, Promise<AnimeEntry[]>>();
const anikotoRecentCache = new Map<
  string,
  { expiresAt: number; entries: AnimeEntry[] }
>();
const anikotoRecentPromises = new Map<string, Promise<AnimeEntry[]>>();
const anikotoSeriesCache = new Map<
  string,
  { expiresAt: number; episodes: AnimeEpisodeMapping[] }
>();
const anikotoSeriesPromises = new Map<
  string,
  Promise<AnimeEpisodeMapping[]>
>();
const ANIME_FEED_CACHE_KEY_PREFIX = "lyra-anime-feed";
const ANIME_SEARCH_CACHE_KEY_PREFIX = "lyra-anime-search";
const ANIME_EPISODE_CACHE_KEY_PREFIX = "lyra-anime-episode-count";
const ANIME_FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const ANIKOTO_RECENT_CACHE_TTL_MS = 30 * 60 * 1000;
const ANIKOTO_SERIES_CACHE_TTL_MS = 10 * 60 * 1000;

interface StoredAnimeFeed {
  anime: AnimeEntry[];
  expiresAt: number;
}

function getAdultAllowed(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("animeAdultContent") === "true"
  );
}

function getAudienceCacheKey(): string {
  return getAdultAllowed() ? "adult" : "safe";
}

function mediaToAnimeEntry(media: AniListMedia): AnimeEntry | null {
  const imageUrl = media.coverImage?.large || media.coverImage?.medium || "";
  if (!imageUrl) return null;
  if (!getAdultAllowed() && media.isAdult) return null;

  const title =
    media.title?.english ||
    media.title?.romaji ||
    media.title?.native ||
    "unknown";
  const titleSearchText = normalizeCatalogText(
    [media.title?.english, media.title?.romaji, media.title?.native]
      .filter(Boolean)
      .join(" "),
  );
  const aniListEpisodeData = deriveAniListEpisodeCount(media);
  const relationEdges = (media.relations?.edges || []).filter(
    (edge) =>
      (edge.relationType === "PREQUEL" || edge.relationType === "SEQUEL") &&
      edge.node &&
      (edge.node.format === "TV" || edge.node.format === "TV_SHORT"),
  );
  const relatedAnimeIds = relationEdges.flatMap((edge) => {
    const ids = normalizeAnimeIds({
      anilist: edge.node?.id,
      mal: edge.node?.idMal,
    });
    return [ids.anilist, ids.mal].filter(
      (id): id is string => Boolean(id),
    );
  });

  const entry: AnimeEntry = {
    id: media.id,
    title,
    year: media.seasonYear,
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    posterSmallUrl: media.coverImage?.medium
      ? `/!cover!/${encodeMochiUrl(media.coverImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(media.averageScore),
    animeType: "anime",
    category: classifyAnimeCategory(media.format, title),
    adult: media.isAdult ?? false,
    ids: normalizeAnimeIds({
      anilist: media.id,
      mal: media.idMal,
    }),
    anilistId: media.id,
    malId: media.idMal,
    format: media.format,
    episodeCount: aniListEpisodeData.count,
    _episodeCountSource: aniListEpisodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: titleSearchText,
  };
  if (relatedAnimeIds.length > 0) {
    entry._relatedAnimeIds = [...new Set(relatedAnimeIds)];
  }
  if (relationEdges.length > 0) {
    entry._relatedSeasonEntries = relationEdges.flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const nodeTitle =
        node.title?.english || node.title?.romaji || node.title?.native;
      if (!nodeTitle) return [];
      const count = deriveAniListEpisodeCount(node);
      return [
        {
          id: node.id,
          title: nodeTitle,
          year: node.seasonYear,
          ids: normalizeAnimeIds({
            anilist: node.id,
            mal: node.idMal,
          }),
          category: classifyAnimeCategory(
            node.format,
            nodeTitle,
            edge.relationType,
          ),
          format: node.format,
          episodeCount: count.count,
          _episodeCountSource: count.source,
          relationType: edge.relationType,
        },
      ];
    });
  }
  return entry;
}

async function fetchAniListEntries(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(ANILIST_URL, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }

  const payload = (await response.json()) as AniListResponse;
  return (payload.data?.Page?.media || [])
    .map(mediaToAnimeEntry)
    .filter((entry): entry is AnimeEntry => entry !== null);
}

async function fetchKitsuEntries(
  query: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[text]=${encodeURIComponent(query)}` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

async function fetchKitsuTrendingEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[status]=current&sort=-userCount` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

function parseProviderNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseEpisodeNumber(value: unknown, title = ""): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  const match = title.match(/\b(?:episode|ep\.?|e)\s*0*(\d+)\b/i);
  if (!match) return undefined;
  const fallback = Number(match[1]);
  return Number.isInteger(fallback) && fallback >= 0 ? fallback : undefined;
}

function splitAnikotoTitles(value?: string): string[] {
  return (value || "")
    .split(/[;\n]/)
    .map((title) => title.trim())
    .filter(Boolean);
}

function anikotoRecordToAnime(record: AnikotoAnimeRecord): AnimeEntry | null {
  const anikotoId = parseProviderNumber(record.id);
  const imageUrl = record.poster || record.background_image || "";
  const title = record.title?.trim() || splitAnikotoTitles(record.titles)[0];
  if (!anikotoId || !imageUrl || !title) return null;

  const titleVariants = [
    title,
    record.alternative,
    record.titles,
    record.native,
  ]
    .flatMap((value) => splitAnikotoTitles(value))
    .filter(Boolean);
  const ids = normalizeAnimeIds({
    anikoto: anikotoId,
    anilist: parseProviderNumber(record.ani_id),
    mal: parseProviderNumber(record.mal_id),
  });
  const year = parseProviderNumber(record.year);
  const episodeData = deriveAnikotoEpisodeCount(record);
  const format = record.terms_by_type?.type?.[0]?.toUpperCase();

  return {
    id: `anikoto:${anikotoId}`,
    title,
    year,
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    backdropUrl: record.background_image
      ? `/!cover!/${encodeMochiUrl(record.background_image)}/`
      : undefined,
    animeType: "anime",
    category: classifyAnimeCategory(format, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format,
    rating: normalizeAnimeRating(record.score),
    episodeCount: episodeData.count,
    _episodeCountSource: episodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(titleVariants.join(" ")),
  };
}

async function fetchAnikotoRecentEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const cacheKey = getAudienceCacheKey();
  const cached = anikotoRecentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  if (cached) anikotoRecentCache.delete(cacheKey);
  const existing = anikotoRecentPromises.get(cacheKey);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/recent-anime?page=1&per_page=50`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("recent anime request failed", {
          code: "ANIME_RECENT_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoRecentResponse;
      return (payload.data || [])
        .map(anikotoRecordToAnime)
        .filter((entry): entry is AnimeEntry => entry !== null);
    })
    .then((entries) => {
      anikotoRecentCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + ANIKOTO_RECENT_CACHE_TTL_MS,
      });
      return entries;
    })
    .catch((error) => {
      anikotoRecentPromises.delete(cacheKey);
      throw error;
    })
    .finally(() => {
      anikotoRecentPromises.delete(cacheKey);
    });
  anikotoRecentPromises.set(cacheKey, promise);
  return promise;
}

export async function fetchAnikotoEpisodes(
  ids: AnimeIds | undefined,
  signal?: AbortSignal,
): Promise<AnimeEpisodeMapping[]> {
  const anikotoId = normalizeAnimeIds(ids).anikoto;
  if (!anikotoId) return [];
  const cached = anikotoSeriesCache.get(anikotoId);
  if (cached && cached.expiresAt > Date.now()) return cached.episodes;
  if (cached) anikotoSeriesCache.delete(anikotoId);
  const existing = anikotoSeriesPromises.get(anikotoId);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/series/${encodeURIComponent(anikotoId)}`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("anime episode request failed", {
          code: "ANIME_EPISODES_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoSeriesResponse;
      return (payload.data?.episodes || [])
        .map((episode): AnimeEpisodeMapping | null => {
          const number = parseEpisodeNumber(episode.number, episode.title);
          if (number == null) return null;
          const episodeId = parseProviderNumber(episode.episode_embed_id);
          const languages = Object.keys(episode.embed_url || {}).filter(
            (language): language is "sub" | "dub" =>
              language === "sub" || language === "dub",
          );
          const mapping: AnimeEpisodeMapping = { number, languages };
          if (episode.title) mapping.title = episode.title;
          if (episodeId) mapping.anikotoEpisodeId = String(episodeId);
          return mapping;
        })
        .filter((episode): episode is AnimeEpisodeMapping => episode !== null)
        .sort((a, b) => a.number - b.number);
    })
    .then((episodes) => {
      anikotoSeriesCache.set(anikotoId, {
        episodes,
        expiresAt: Date.now() + ANIKOTO_SERIES_CACHE_TTL_MS,
      });
      return episodes;
    })
    .catch((error) => {
      anikotoSeriesPromises.delete(anikotoId);
      throw error;
    })
    .finally(() => {
      anikotoSeriesPromises.delete(anikotoId);
    });
  anikotoSeriesPromises.set(anikotoId, promise);
  return promise;
}

async function fetchKitsuEpisodeCount(kitsuId: string): Promise<number> {
  const url =
    `${KITSU_API_URL}/anime/${encodeURIComponent(kitsuId)}/episodes` +
    "?page[limit]=20";
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`);
  if (!response.ok) return 0;
  const payload = (await response.json()) as KitsuEpisodeResponse;
  const metadataCount = parseProviderNumber(payload.meta?.count);
  if (metadataCount) return metadataCount;
  return Math.max(
    0,
    ...(payload.data || [])
      .map((episode) => parseProviderNumber(episode.attributes?.number))
      .filter((number): number is number => number != null),
  );
}

function formatsCanShareTitle(
  left?: string,
  right?: string,
): boolean {
  const a = left?.toUpperCase();
  const b = right?.toUpperCase();
  if (!a || !b || a === b) return true;
  return [a, b].every((format) => format === "TV" || format === "TV_SHORT");
}

function isTelevisionFormat(format?: string): boolean {
  const normalized = format?.toUpperCase();
  return normalized === "TV" || normalized === "TV_SHORT";
}

interface AnimeTitleParts {
  franchiseTitle: string;
  seasonNumber: number | undefined;
  partNumber: number | undefined;
  isFinalSeason: boolean;
}

function seasonNumberFromTitle(title: string): number | undefined {
  const match = title.match(
    /(?:season|series)\s+(\d+)|\b(\d+)(?:st|nd|rd|th)\s+season\b/i,
  );
  const explicitNumber = Number(match?.[1] || match?.[2]);
  if (Number.isInteger(explicitNumber) && explicitNumber > 0) {
    return explicitNumber;
  }

  
  
  if (/\b(?:part|cour)\s*\d+\b/i.test(title)) return undefined;

  
  
  
  const trailingNumber = title.match(/\s([2-9]|1[0-2])\s*$/i);
  const number = Number(trailingNumber?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function seasonPartFromTitle(title: string): number | undefined {
  const match = title.match(/\b(?:part|cour)\s*(\d+)\b/i);
  const number = Number(match?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function isFinalSeasonTitle(title: string): boolean {
  return /\b(?:the\s+)?final\s+(?:season|chapters?)\b|\b(?:season|series)\s+final\b/i.test(
    title,
  );
}

function stripSeasonSuffix(title: string): string {
  let stripped = title.trim();
  const suffixes = [
    /\s+(?:the\s+)?final\s+(?:season|chapters?)(?:\s+(?:part|cour)\s+\d+)?\s*$/i,
    /\s+(?:season|series)\s+\d+(?:\s+(?:part|cour)\s+\d+)?\s*$/i,
    /\s+\d+(?:st|nd|rd|th)\s+season(?:\s+(?:part|cour)\s+\d+)?\s*$/i,
    /\s+(?:season|series)\s+final(?:\s+(?:part|cour)\s+\d+)?\s*$/i,
    /\s+(?:part|cour)\s+\d+\s*$/i,
    /\s+(?:[2-9]|1[0-2])\s*$/i,
  ];
  for (const suffix of suffixes) {
    const next = stripped.replace(suffix, "").trim();
    if (next && next !== stripped) stripped = next;
  }

  
  
  
  
  const inlineSeasonMarker = stripped.match(
    /\s+(?:(?:the\s+)?final\s+(?:season|chapters?)|(?:season|series)\s+(?:\d+|final)|\d+(?:st|nd|rd|th)\s+season)\b/i,
  );
  if (inlineSeasonMarker?.index != null) {
    const next = stripped
      .slice(0, inlineSeasonMarker.index)
      .replace(/[\s:;,|\-–—]+$/u, "")
      .trim();
    if (next) stripped = next;
  }

  return stripped.replace(/[\s:;,|\-–—]+$/u, "").trim();
}

function animeTitleParts(title: string): AnimeTitleParts {
  return {
    franchiseTitle: stripSeasonSuffix(title),
    seasonNumber: seasonNumberFromTitle(title),
    partNumber: seasonPartFromTitle(title),
    isFinalSeason: isFinalSeasonTitle(title),
  };
}

function animeFranchiseKey(
  entry: Pick<AnimeEntry, "title" | "format" | "category">,
): string | null {
  if (
    classifyAnimeCategory(entry.format, entry.title) !== "main-season" ||
    (entry.category && entry.category !== "main-season")
  ) {
    return null;
  }
  return normalizeCatalogText(animeTitleParts(entry.title).franchiseTitle);
}

function animeTitleIsBase(title: string): boolean {
  return (
    normalizeCatalogText(animeTitleParts(title).franchiseTitle) ===
    normalizeCatalogText(title)
  );
}

function animeSeasonGroupKey(
  entry: AnimeEntry,
  franchiseKeyOverride?: string | null,
): string | null {
  const franchiseKey = franchiseKeyOverride ?? animeFranchiseKey(entry);
  if (!franchiseKey) return null;
  const parts = animeTitleParts(entry.title);
  if (parts.seasonNumber) return `${franchiseKey}:season:${parts.seasonNumber}`;
  if (parts.isFinalSeason) return `${franchiseKey}:final`;
  if (parts.partNumber) return `${franchiseKey}:season:1`;
  if (animeTitleIsBase(entry.title)) return `${franchiseKey}:season:1`;
  return `${franchiseKey}:entry:${normalizeCatalogText(entry.title)}:${entry.year || 0}`;
}

function animeEntryToSeason(entry: AnimeEntry, fallbackNumber: number): AnimeSeason {
  const season: AnimeSeason = {
    id: entry.id,
    title: entry.title,
    year: entry.year,
    number: seasonNumberFromTitle(entry.title) ||
      (animeTitleIsBase(entry.title) ? 1 : fallbackNumber),
    ids: normalizeAnimeIds({
      ...entry.ids,
      anilistId: entry.anilistId,
      malId: entry.malId,
    }),
    category: entry.category || classifyAnimeCategory(entry.format, entry.title),
    format: entry.format,
    episodeCount: entry.episodeCount,
    _episodeCountSource: entry._episodeCountSource,
  };
  return season;
}

function seasonToAnimeEntry(season: AnimeSeason): AnimeEntry {
  return {
    id: season.id,
    title: season.title,
    year: season.year,
    posterUrl: "",
    animeType: "anime",
    category: season.category || classifyAnimeCategory(season.format, season.title),
    ids: normalizeAnimeIds(season.ids),
    format: season.format,
    episodeCount: season.episodeCount,
    _episodeCountSource: season._episodeCountSource,
  };
}

function seasonToAnimeEntries(season: AnimeSeason): AnimeEntry[] {
  const hasParts = (season.parts?.length || 0) > 1;
  const base = seasonToAnimeEntry(
    hasParts ? { ...season, episodeCount: undefined } : season,
  );
  if (!hasParts) return [base];
  return [
    base,
    ...(season.parts || []).map((part) => ({
      id: part.id,
      title: part.title,
      year: part.year,
      posterUrl: "",
      animeType: "anime" as const,
      category: season.category || "main-season",
      ids: normalizeAnimeIds(part.ids),
      format: season.format,
      episodeCount: part.episodeCount,
    })),
  ];
}

function sharedProviderIdentity(left: AnimeEntry, right: AnimeEntry): boolean {
  const leftIds = normalizeAnimeIds({
    ...left.ids,
    anilistId: left.anilistId,
    malId: left.malId,
  });
  const rightIds = normalizeAnimeIds({
    ...right.ids,
    anilistId: right.anilistId,
    malId: right.malId,
  });
  return Object.entries(leftIds).some(
    ([provider, id]) =>
      provider !== "anikotoEpisode" &&
      rightIds[provider as keyof AnimeIds] === id,
  );
}

function dedupeSeasonEntries(entries: readonly AnimeEntry[]): AnimeEntry[] {
  const unique: AnimeEntry[] = [];
  for (const entry of entries) {
    const ids = normalizeAnimeIds({
      ...entry.ids,
      anilistId: entry.anilistId,
      malId: entry.malId,
    });
    const existing = unique.find(
      (candidate) =>
        sharedProviderIdentity(candidate, entry) ||
        (normalizeCatalogText(candidate.title) ===
          normalizeCatalogText(entry.title) &&
          (candidate.year || 0) === (entry.year || 0)),
    );
    if (!existing) {
      unique.push({ ...entry, ids });
      continue;
    }
    mergeEpisodeCount(existing, entry, ids);
    existing.ids = mergeAnimeIds(existing.ids, ids);
    existing.year ??= entry.year;
    existing.category ||= entry.category;
    existing.format ||= entry.format;
  }
  return unique;
}

function aggregateSeasonEpisodeCount(entries: readonly AnimeEntry[]): number | undefined {
  const counts = entries
    .map((entry) => entry.episodeCount)
    .filter(
      (count): count is number =>
        typeof count === "number" && Number.isInteger(count) && count > 0,
    );
  if (counts.length === 0) return undefined;

  const partEntries = entries.filter(
    (entry) => seasonPartFromTitle(entry.title) != null,
  );
  if (partEntries.length === 0) return Math.max(...counts);

  const baseEntries = entries.filter(
    (entry) => seasonPartFromTitle(entry.title) == null,
  );
  const baseCount = Math.max(
    0,
    ...baseEntries
      .map((entry) => entry.episodeCount || 0)
      .filter((count) => count > 0),
  );
  const baseIsAiring = baseEntries.some((entry) =>
    entry._episodeCountSource === "anikotoAiring" ||
    entry._episodeCountSource === "anilistAiring",
  );
  if (baseCount > 0 && baseIsAiring) return baseCount;

  const partCount = partEntries.reduce(
    (total, entry) => total + (entry.episodeCount || 0),
    0,
  );
  if (baseCount === 0) return partCount || undefined;
  return baseCount >= partCount * 2 ? baseCount : baseCount + partCount;
}

function buildSeasonOptions(
  entries: readonly AnimeEntry[],
  franchiseKeyOverride?: string | null,
): AnimeSeason[] {
  const groups = new Map<string, AnimeEntry[]>();
  for (const entry of entries) {
    const key = animeSeasonGroupKey(entry, franchiseKeyOverride);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }

  const grouped = [...groups.entries()].map(([key, group]) => {
    const descriptor = group
      .map((entry) => ({ entry, parts: animeTitleParts(entry.title) }))
      .sort(
        (left, right) =>
          Number(
            Boolean(
              right.parts.seasonNumber ||
                right.parts.partNumber ||
                right.parts.isFinalSeason,
            ),
          ) -
            Number(
              Boolean(
                left.parts.seasonNumber ||
                  left.parts.partNumber ||
                  left.parts.isFinalSeason,
              ),
            ),
      )[0];
    const descriptorTitle = descriptor?.entry.title || group[0]?.title || "";
    return {
      key,
      entries: dedupeSeasonEntries(group),
      parts: descriptor?.parts || animeTitleParts(descriptorTitle),
      isBase: animeTitleIsBase(descriptorTitle),
      year: Math.min(
        ...group
          .map((entry) => entry.year || Number.MAX_SAFE_INTEGER)
          .filter((year) => year < Number.MAX_SAFE_INTEGER),
      ),
    };
  });
  const maxExplicitSeason = Math.max(
    0,
    ...grouped.map((group) => group.parts.seasonNumber || 0),
  );
  grouped.sort(
    (left, right) =>
      (left.parts.seasonNumber || (left.isBase ? 1 : Number.MAX_SAFE_INTEGER)) -
        (right.parts.seasonNumber ||
          (right.isBase ? 1 : Number.MAX_SAFE_INTEGER)) ||
      (left.parts.isFinalSeason ? 1 : 0) - (right.parts.isFinalSeason ? 1 : 0) ||
      left.year - right.year ||
      left.key.localeCompare(right.key),
  );

  const usedNumbers = new Set<number>();
  let nextNumber = 1;
  return grouped.map((group) => {
    let number = group.parts.seasonNumber || (group.isBase ? 1 : undefined);
    if (!number && group.parts.isFinalSeason) {
      number = Math.max(maxExplicitSeason + 1, nextNumber);
    }
    if (!number) {
      while (usedNumbers.has(nextNumber)) nextNumber += 1;
      number = nextNumber;
    }
    usedNumbers.add(number);
    nextNumber = Math.max(nextNumber, number + 1);

    const canonical = [...group.entries].sort(
      (left, right) =>
        Number(Boolean(right.ids?.anikoto)) - Number(Boolean(left.ids?.anikoto)) ||
        episodeCountSourceRank(right._episodeCountSource, Boolean(right.ids?.anikoto)) -
          episodeCountSourceRank(left._episodeCountSource, Boolean(left.ids?.anikoto)) ||
        Number(Boolean(right.year)) - Number(Boolean(left.year)) ||
        (seasonPartFromTitle(left.title) || 1) -
          (seasonPartFromTitle(right.title) || 1) ||
        left.title.localeCompare(right.title),
    )[0]!;
    const season = animeEntryToSeason(canonical, number);
    season.number = number;
    season.year =
      canonical.year ||
      group.entries.find((entry) => entry.year != null)?.year;
    season.episodeCount = aggregateSeasonEpisodeCount(group.entries);
    season.parts = group.entries
      .slice()
      .sort(
        (left, right) =>
          (seasonPartFromTitle(left.title) || 1) -
            (seasonPartFromTitle(right.title) || 1) ||
          (left.year || Number.MAX_SAFE_INTEGER) -
            (right.year || Number.MAX_SAFE_INTEGER),
      )
      .map((entry, index) => ({
        id: entry.id,
        title: entry.title,
        year: entry.year,
        number: seasonPartFromTitle(entry.title) || index + 1,
        ids: normalizeAnimeIds({
          ...entry.ids,
          anilistId: entry.anilistId,
          malId: entry.malId,
        }),
        episodeCount: entry.episodeCount,
      }));
    if (season.parts.length <= 1) delete season.parts;
    return season;
  });
}

function relationCanBeMainSeason(
  entry: AnimeEntry,
  relation: AnimeRelation,
  category: AnimeEntryCategory,
): boolean {
  if (category !== "main-season") return false;
  if (relation.format?.trim()) return true;

  
  
  
  
  const parts = animeTitleParts(relation.name);
  const relationFranchise = normalizeCatalogText(parts.franchiseTitle);
  const entryFranchise = animeFranchiseKey(entry);
  const entryAliasText = normalizeCatalogText(entry._searchText || "");
  return Boolean(
    parts.seasonNumber ||
      parts.partNumber ||
      parts.isFinalSeason ||
      (entryFranchise &&
        relationFranchise &&
        (relationFranchise === entryFranchise ||
          entryAliasText.includes(relationFranchise))),
  );
}

export function mergeAnimeRelationSeasons(
  entry: AnimeEntry,
  relations: readonly AnimeRelation[],
): AnimeSeason[] {
  const relationEntries = relations.flatMap((relation) => {
    const category = classifyAnimeCategory(
      relation.format,
      relation.name,
      relation.relation,
    );
    if (!relationCanBeMainSeason(entry, relation, category)) return [];
    return [
      {
        id: `mal:${relation.malId}`,
        title: relation.name,
        year: relation.year,
        posterUrl: "",
        animeType: "anime" as const,
        category,
        ids: normalizeAnimeIds({ mal: relation.malId }),
        format: relation.format || "TV",
        episodeCount: relation.episodeCount,
        relationType: relation.relation,
      },
    ];
  });
  const rawSources = [
    entry,
    ...(entry.seasons || []).flatMap(seasonToAnimeEntries),
    ...relationEntries,
  ];
  const sources = dedupeSeasonEntries(
    rawSources.map((source) => {
      const explicitRelation = relationEntries.find((relationEntry) => {
        if (!sharedProviderIdentity(source, relationEntry)) return false;
        const parts = animeTitleParts(relationEntry.title);
        return Boolean(
          parts.seasonNumber || parts.partNumber || parts.isFinalSeason,
        );
      });
      return explicitRelation
        ? { ...source, title: explicitRelation.title }
        : source;
    }),
  );
  const seasons = buildSeasonOptions(sources, animeFranchiseKey(entry));
  return seasons.length > 1 ? seasons : [];
}

function mergeEpisodeCount(
  existing: AnimeEntry,
  incoming: AnimeEntry,
  incomingIds: AnimeIds,
): void {
  const incomingCount = incoming.episodeCount;
  if (!incomingCount || incomingCount < 1) return;
  const existingCount = existing.episodeCount || 0;
  const incomingSource =
    incoming._episodeCountSource ||
    (incomingIds.anikoto ? "anikoto" : undefined);
  const existingRank = episodeCountSourceRank(
    existing._episodeCountSource,
    Boolean(existing.ids?.anikoto),
  );
  const incomingRank = episodeCountSourceRank(
    incomingSource,
    Boolean(incomingIds.anikoto),
  );
  if (!existingCount || incomingRank > existingRank) {
    existing.episodeCount = incomingCount;
    existing._episodeCountSource = incomingSource;
    return;
  }
  if (incomingRank === existingRank) {
    existing.episodeCount = Math.max(existingCount, incomingCount);
  }
}

function episodeCountSourceRank(
  source: AnimeEntry["_episodeCountSource"],
  hasAnikoto: boolean,
): number {
  if (source === "anikotoAiring") return 5;
  if (hasAnikoto || source === "anikoto") return 4;
  if (source === "anilist") return 3;
  if (source === "anilistAiring") return 2;
  if (source === "kitsu") return 1;
  return 0;
}

export function mergeAnimeEntries(
  ...groups: ReadonlyArray<AnimeEntry>[]
): AnimeEntry[] {
  interface AnimeFamily {
    franchiseKey: string | null;
    seasonEntries: AnimeEntry[];
    relatedSeasons: AnimeSeason[];
  }

  const families: AnimeFamily[] = [];
  const providerKeys = new Map<string, AnimeFamily>();
  const titleYearFamilies = new Map<string, AnimeFamily[]>();
  const franchiseFamilies = new Map<string, AnimeFamily>();

  const registerTitleYear = (family: AnimeFamily, entry: AnimeEntry) => {
    const key = `title-year:${normalizeCatalogText(entry.title)}:${entry.year || 0}`;
    const entries = titleYearFamilies.get(key) || [];
    if (!entries.includes(family)) entries.push(family);
    titleYearFamilies.set(key, entries);
  };

  const findSameSeason = (
    entry: AnimeEntry,
    ids: AnimeIds,
  ): AnimeFamily | undefined => {
    const identityKeys = Object.entries(ids)
      .filter(([provider]) => provider !== "anikotoEpisode")
      .map(([provider, id]) => `${provider}:${id}`);
    for (const key of identityKeys) {
      const family = providerKeys.get(key);
      if (family) return family;
    }
    const titleKey = `title-year:${normalizeCatalogText(entry.title)}:${entry.year || 0}`;
    return titleYearFamilies
      .get(titleKey)
      ?.find((family) =>
        family.seasonEntries.some((candidate) =>
          formatsCanShareTitle(candidate.format, entry.format),
        ),
      );
  };

  const addRelatedSeasons = (family: AnimeFamily, entry: AnimeEntry) => {
    const familyKey = family.franchiseKey;
    if (!familyKey) return;
    for (const related of entry._relatedSeasonEntries || []) {
      if (
        !isTelevisionFormat(related.format) ||
        animeFranchiseKey({ title: related.title, format: related.format }) !==
          familyKey
      ) {
        continue;
      }
      const key = `related:${related.ids.anilist || related.ids.mal || related.id}`;
      if (
        !family.relatedSeasons.some(
          (candidate) =>
            `related:${candidate.ids.anilist || candidate.ids.mal || candidate.id}` ===
            key,
        )
      ) {
        family.relatedSeasons.push(related);
      }
    }
  };

  for (const group of groups) {
    for (const entry of group) {
      const ids = normalizeAnimeIds({
        ...entry.ids,
        anilistId: entry.anilistId,
        malId: entry.malId,
      });
      const sameSeasonFamily = findSameSeason(entry, ids);
      const family =
        sameSeasonFamily ||
        (animeFranchiseKey(entry)
          ? franchiseFamilies.get(animeFranchiseKey(entry)!)
          : undefined);

      if (!family) {
        const created: AnimeFamily = {
          franchiseKey: animeFranchiseKey(entry),
          seasonEntries: [
            { ...entry, ids },
            ...(entry.seasons || []).flatMap(seasonToAnimeEntries),
          ],
          relatedSeasons: [],
        };
        families.push(created);
        const franchiseKey = created.franchiseKey;
        if (franchiseKey) franchiseFamilies.set(franchiseKey, created);
        registerTitleYear(created, created.seasonEntries[0]!);
        for (const seasonEntry of created.seasonEntries) {
          for (const [provider, id] of Object.entries(seasonEntry.ids || {})) {
            if (provider !== "anikotoEpisode") {
              providerKeys.set(`${provider}:${id}`, created);
            }
          }
        }
        addRelatedSeasons(created, entry);
        continue;
      }

      if (sameSeasonFamily) {
        const sameSeason = family.seasonEntries.find((candidate) => {
          const candidateIds = normalizeAnimeIds(candidate.ids);
          return (
            Object.entries(ids).some(
              ([provider, id]) => candidateIds[provider as keyof AnimeIds] === id,
            ) ||
            (normalizeCatalogText(candidate.title) ===
              normalizeCatalogText(entry.title) &&
              (candidate.year || 0) === (entry.year || 0))
          );
        });
        if (sameSeason) {
          mergeEpisodeCount(sameSeason, entry, ids);
          sameSeason.ids = mergeAnimeIds(sameSeason.ids, ids);
          sameSeason.year ??= entry.year;
          sameSeason.anilistId ||= ids.anilist
            ? Number(ids.anilist)
            : undefined;
          sameSeason.malId ||= ids.mal ? Number(ids.mal) : undefined;
          sameSeason.posterSmallUrl ||= entry.posterSmallUrl;
          sameSeason.backdropUrl ||= entry.backdropUrl;
          sameSeason.rating ??= entry.rating;
          addRelatedSeasons(family, entry);
        }
      } else {
        family.seasonEntries.push({ ...entry, ids });
        registerTitleYear(family, entry);
        for (const [provider, id] of Object.entries(ids)) {
          if (provider !== "anikotoEpisode") {
            providerKeys.set(`${provider}:${id}`, family);
          }
        }
        addRelatedSeasons(family, entry);
      }
    }
  }

  return families.map((family) => {
    const seasonEntries = dedupeSeasonEntries([
      ...family.seasonEntries,
      ...family.relatedSeasons.map(seasonToAnimeEntry),
    ]);
    const primary = [...dedupeSeasonEntries(family.seasonEntries)].sort((left, right) => {
      const leftBase = animeTitleIsBase(left.title) ? 0 : 1;
      const rightBase = animeTitleIsBase(right.title) ? 0 : 1;
      return leftBase - rightBase ||
        (left.year || Number.MAX_SAFE_INTEGER) -
          (right.year || Number.MAX_SAFE_INTEGER);
    })[0] || family.seasonEntries[0]!;
    const displayTitle = animeTitleIsBase(primary.title)
      ? primary.title
      : stripSeasonSuffix(primary.title);
    const uniqueSeasons = buildSeasonOptions(seasonEntries);
    const result: AnimeEntry = {
      ...primary,
      title: displayTitle || primary.title,
      ids: normalizeAnimeIds(primary.ids),
      anilistId: primary.ids?.anilist
        ? Number(primary.ids.anilist)
        : primary.anilistId,
      malId: primary.ids?.mal ? Number(primary.ids.mal) : primary.malId,
    _normalizedTitle: normalizeCatalogText(displayTitle || primary.title),
      _searchText: normalizeCatalogText(
        seasonEntries.map((entry) => entry._searchText || entry.title).join(" "),
      ),
    };
    if (uniqueSeasons.length > 1) result.seasons = uniqueSeasons;
    else delete result.seasons;
    return result;
  });
}

export function mergeAnimeFranchiseCandidates(
  entry: AnimeEntry,
  candidates: readonly AnimeEntry[],
): AnimeEntry {
  const franchiseKey =
    animeFranchiseKey(entry) ||
    candidates.map((candidate) => animeFranchiseKey(candidate)).find(Boolean) ||
    null;
  const entrySeasonSources =
    entry.seasons && entry.seasons.length > 0
      ? entry.seasons.flatMap(seasonToAnimeEntries)
      : [entry];
  const candidateSources = candidates
    .filter((candidate) => {
      const sources =
        candidate.seasons && candidate.seasons.length > 0
          ? candidate.seasons.flatMap(seasonToAnimeEntries)
          : [candidate];
      return (
        animeFranchiseKey(candidate) === franchiseKey ||
        sources.some((source) =>
          [entry, ...entrySeasonSources].some((entrySource) =>
            sharedProviderIdentity(entrySource, source),
          ),
        )
      );
    })
    .flatMap((candidate) =>
      candidate.seasons && candidate.seasons.length > 0
        ? candidate.seasons.flatMap(seasonToAnimeEntries)
        : [candidate],
    );
  const seasonSources = [...entrySeasonSources, ...candidateSources].filter(
    (source) => animeFranchiseKey(source) !== null,
  );
  const seasons = buildSeasonOptions(seasonSources, franchiseKey);

  
  
  
  
  
  return seasons.length > 1 ? { ...entry, seasons } : entry;
}

function fetchAniListSorted(sort: "TRENDING_DESC" | "POPULARITY_DESC") {
  const cacheKey = `${sort}:${getAudienceCacheKey()}`;
  const cached = sortedAnimePromises.get(cacheKey);
  if (cached) return cached;

  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        media(sort: ${sort}, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  const promise = fetchAniListEntries(query, { page: 1 }).catch((err) => {
    sortedAnimePromises.delete(cacheKey);
    throw err;
  });
  sortedAnimePromises.set(cacheKey, promise);
  return promise;
}

async function fetchTrendingAnimeEntries(): Promise<AnimeEntry[]> {
  const anilistTrending = await fetchAniListSorted("TRENDING_DESC").catch(
    () => [] as AnimeEntry[],
  );
  if (anilistTrending.length > 0) return anilistTrending;
  return fetchKitsuTrendingEntries().catch(() => [] as AnimeEntry[]);
}

function getCacheKey(category: AnimeCategory): Promise<string> {
  return cacheKey(
    ANIME_FEED_CACHE_KEY_PREFIX,
    import.meta.url,
    `${category}-${getAudienceCacheKey()}`,
  );
}

function applySearchFields(anime: AnimeEntry[]): AnimeEntry[] {
  for (const a of anime) {
    a.ids = normalizeAnimeIds({
      ...a.ids,
      anilistId: a.anilistId,
      malId: a.malId,
    });
    a._normalizedTitle = normalizeCatalogText(a.title || "");
    a._searchText ||= a._normalizedTitle;
  }
  return anime;
}

export function searchAnimeLocally(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];

  const tokens = normalizedQuery.split(" ");
  const ranked: AnimeEntry[][] = [[], [], [], [], []];
  for (const entry of anime) {
    const rank = catalogMatchRank(
      entry._normalizedTitle ?? normalizeCatalogText(entry.title),
      entry._searchText || "",
      normalizedQuery,
      tokens,
    );
    if (rank >= 0) ranked[rank]!.push(entry);
  }
  return ranked.flat();
}

function filterAnimeSearchResults(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];
  const tokens = normalizedQuery.split(" ");
  return anime.filter(
    (entry) =>
      catalogMatchRank(
        entry._normalizedTitle ?? normalizeCatalogText(entry.title),
        entry._searchText || "",
        normalizedQuery,
        tokens,
      ) >= 0,
  );
}

function saveToCacheKey(cacheKey: string, anime: AnimeEntry[]): AnimeEntry[] {
  try {
    const stored: StoredAnimeFeed = {
      anime,
      expiresAt: Date.now() + ANIME_FEED_CACHE_TTL_MS,
    };
    localStorage.setItem(cacheKey, JSON.stringify(stored));
  } catch {
    
  }
  return anime;
}

export async function fetchAnimeData(
  category: AnimeCategory,
  onUpdate?: AnimeFeedSubscriber,
): Promise<AnimeEntry[]> {
  const generation = animeFeedGeneration;
  const cacheKey = await getCacheKey(category);
  if (generation !== animeFeedGeneration) return [];
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const stored = JSON.parse(cached) as StoredAnimeFeed;
      if (
        stored.expiresAt > Date.now() &&
        Array.isArray(stored.anime) &&
        stored.anime.length > 0
      ) {
        const anime = applySearchFields(stored.anime);
        try {
          onUpdate?.(anime);
        } catch {}
        return anime;
      }
      localStorage.removeItem(cacheKey);
    }
  } catch {}

  const inFlight = animeFeedRequests.get(cacheKey);
  if (inFlight) {
    if (inFlight.latest.length > 0) {
      try {
        onUpdate?.(inFlight.latest);
      } catch {}
    }
    if (!onUpdate) return inFlight.promise;
    inFlight.subscribers.add(onUpdate);
    return inFlight.promise.finally(() => {
      inFlight.subscribers.delete(onUpdate);
    });
  }

  const request: AnimeFeedRequest = {
    promise: Promise.resolve([]),
    latest: [],
    subscribers: new Set(onUpdate ? [onUpdate] : []),
  };

  const promise = (async () => {
    let providers: Array<() => Promise<AnimeEntry[]>>;

    switch (category) {
      case "trending":
        providers = [fetchTrendingAnimeEntries, fetchAnikotoRecentEntries];
        break;
      case "anime":
        providers = [
          fetchTrendingAnimeEntries,
          () => fetchAniListSorted("POPULARITY_DESC"),
          fetchAnikotoRecentEntries,
        ];
        break;
      default:
        providers = [];
    }

    const providerResults: Array<AnimeEntry[] | undefined> = Array.from({
      length: providers.length,
    });
    await Promise.all(
      providers.map((fetchProvider, index) =>
        fetchProvider()
          .catch(() => [] as AnimeEntry[])
          .then((anime) => {
            if (generation !== animeFeedGeneration) return;
            providerResults[index] = anime;
            if (anime.length === 0) return;
            request.latest = applySearchFields(
              mergeAnimeEntries(
                ...providerResults.map((results) => results || []),
              ),
            );
            for (const subscriber of request.subscribers) {
              try {
                subscriber(request.latest);
              } catch {}
            }
          }),
      ),
    );

    const anime = request.latest;
    if (generation !== animeFeedGeneration) return [];
    return anime.length > 0 ? saveToCacheKey(cacheKey, anime) : anime;
  })().finally(() => {
    if (animeFeedRequests.get(cacheKey) === request) {
      animeFeedRequests.delete(cacheKey);
    }
  });

  request.promise = promise;
  animeFeedRequests.set(cacheKey, request);
  return promise.finally(() => {
    if (onUpdate) request.subscribers.delete(onUpdate);
  });
}

export async function searchAnime(
  query: string,
  signal?: AbortSignal,
  onUpdate?: (results: AnimeEntry[]) => void,
  options: { forceRefresh?: boolean } = {},
): Promise<AnimeEntry[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const forceRefresh = options.forceRefresh === true;

  const searchCacheKey = await cacheKey(
    ANIME_SEARCH_CACHE_KEY_PREFIX,
    import.meta.url,
    `${getAudienceCacheKey()}-${trimmed.toLowerCase()}`,
  );
  try {
    if (!forceRefresh && typeof sessionStorage !== "undefined") {
      const cached = sessionStorage.getItem(searchCacheKey);
      if (cached) {
        const results = applySearchFields(JSON.parse(cached) as AnimeEntry[]);
        onUpdate?.(results);
        return results;
      }
    }
  } catch {
    
  }

  const inFlight = searchAnimePromises.get(searchCacheKey);
  if (inFlight && !forceRefresh && !signal && !onUpdate) return inFlight;

  const anilistQuery = `
    query ($search: String) {
      Page(page: 1, perPage: 25) {
        media(search: $search, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  let results: AnimeEntry[] = [];
  let providersCompleted = 0;
  const publish = (providerResults: AnimeEntry[]) => {
    if (signal?.aborted) return;
    const filtered = filterAnimeSearchResults(providerResults, trimmed);
    results = applySearchFields(mergeAnimeEntries(results, filtered));
    onUpdate?.(results);
  };

  const promise = Promise.all([
    fetchAniListEntries(anilistQuery, { search: trimmed }, signal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (signal?.aborted) throw error;
      })
      .finally(() => {
        providersCompleted += 1;
      }),
    fetchKitsuEntries(trimmed, signal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (signal?.aborted) throw error;
      })
      .finally(() => {
        providersCompleted += 1;
      }),
  ])
    .then(() => {
  if (signal?.aborted) {
    throw new DOMException("anime request aborted... /ᐠ - ˕ -マ", "AbortError");
  }
      if (providersCompleted === 0) return [];
      try {
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(searchCacheKey, JSON.stringify(results));
        }
      } catch {}
      return results;
    })
    .finally(() => {
      if (searchAnimePromises.get(searchCacheKey) === promise) {
        searchAnimePromises.delete(searchCacheKey);
      }
    });

  searchAnimePromises.set(searchCacheKey, promise);
  return promise;
}

export function resetAnimeCache(): void {
  animeFeedGeneration += 1;
  for (const request of animeFeedRequests.values()) {
    request.subscribers.clear();
  }
  animeFeedRequests.clear();
  sortedAnimePromises.clear();
  searchAnimePromises.clear();
  anikotoRecentCache.clear();
  anikotoRecentPromises.clear();
  anikotoSeriesCache.clear();
  anikotoSeriesPromises.clear();
  _jikanEpsCache.clear();
  _jikanEpsPromises.clear();
  _jikanRelCache.clear();
  resetAnimeIdentityCache();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("lyra-anime-")) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("lyra-anime-feed-")) localStorage.removeItem(key);
    }
  } catch {
    
  }
}

const _jikanEpsCache = new Map<string, number>();
const _jikanEpsPromises = new Map<string, Promise<number>>();

async function fetchIdentityEpisodeCount(ids: AnimeIds): Promise<number> {
  if (ids.anikoto) {
    const episodes = await fetchAnikotoEpisodes(ids);
    if (episodes.length > 0) {
      return Math.max(1, ...episodes.map((episode) => episode.number));
    }
  }

  if (ids.kitsu) {
    const count = await fetchKitsuEpisodeCount(ids.kitsu);
    if (count > 0) return count;
  }

  if (ids.mal) {
    const response = await fetch(
      `/api/anime/episodes/${encodeURIComponent(ids.mal)}`,
    );
    if (response.ok) {
      const episodePayload = (await response.json()) as { count?: number };
      if (episodePayload.count && episodePayload.count > 0) return episodePayload.count;
    }
  }

  const response = await fetch("/api/anime/identity/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) return 0;
  const identity = (await response.json()) as { episodes?: number };
  return Number.isInteger(identity.episodes) && (identity.episodes || 0) > 0
    ? identity.episodes || 0
    : 0;
}

export function chooseEpisodeCount(
  knownCount?: number,
  resolvedCount?: number,
): number {
  const known = Number.isInteger(knownCount) && (knownCount || 0) > 0
    ? knownCount || 0
    : 0;
  const resolved = Number.isInteger(resolvedCount) && (resolvedCount || 0) > 0
    ? resolvedCount || 0
    : 0;
  if (known > 1) return known;
  return resolved || known;
}

export async function fetchAnimeEpisodeCount(
  input: number | AnimeIds,
): Promise<number> {
  const ids = normalizeAnimeIds(
    typeof input === "number" ? { mal: input } : input,
  );
  const malId = ids.mal;
  const episodeIdentityKey = ids.anikoto
    ? `anikoto:${ids.anikoto}`
    : ids.kitsu
      ? `kitsu:${ids.kitsu}`
      : malId
        ? `mal:${malId}`
        : `identity:${JSON.stringify(Object.entries(ids).sort())}`;
  const cached = _jikanEpsCache.get(episodeIdentityKey);
  if (cached != null) return cached;

  const storageKey = await cacheKey(
    ANIME_EPISODE_CACHE_KEY_PREFIX,
    import.meta.url,
    episodeIdentityKey,
  );
  try {
    const stored = Number(sessionStorage.getItem(storageKey));
    if (Number.isInteger(stored) && stored > 0) {
      _jikanEpsCache.set(episodeIdentityKey, stored);
      return stored;
    }
  } catch {}

  const inFlight = _jikanEpsPromises.get(episodeIdentityKey);
  if (inFlight) return inFlight;

  const promise = (malId && !ids.kitsu && !ids.anikoto
    ? fetch(`/api/anime/episodes/${encodeURIComponent(malId)}`)
        .then(async (response) => {
          if (!response.ok) return 0;
          const episodePayload = (await response.json()) as { count?: number };
          return episodePayload.count || 0;
        })
    : fetchIdentityEpisodeCount(ids)
  )
    .then((count) => {
      if (count > 0) {
        _jikanEpsCache.set(episodeIdentityKey, count);
        try {
          sessionStorage.setItem(storageKey, String(count));
        } catch {}
      }
      return count;
    })
    .catch(() => 0)
    .finally(() => {
      _jikanEpsPromises.delete(episodeIdentityKey);
    });
  _jikanEpsPromises.set(episodeIdentityKey, promise);
  return promise;
}

export interface AnimeRelation {
  malId: number;
  name: string;
  relation: string;
  format?: string;
  year?: number;
  episodeCount?: number;
}

const _jikanRelCache = new Map<number, AnimeRelation[]>();

interface RawRelation {
  mal_id: number;
  name: string;
  relation: string;
  format?: string;
  year?: number;
  episode_count?: number;
}

async function fetchAnimeRelations(
  malId: number,
): Promise<AnimeRelation[]> {
  const cached = _jikanRelCache.get(malId);
  if (cached) return cached;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/anime/relations/${malId}`);
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) return [];
        continue;
      }
      const relationPayload = (await response.json()) as { relations?: RawRelation[] };
      const relations = (relationPayload.relations || []).map((rawRelation) => {
        const relation: AnimeRelation = {
          malId: rawRelation.mal_id,
          name: rawRelation.name,
          relation: rawRelation.relation,
        };
        if (rawRelation.format) relation.format = rawRelation.format;
        if (rawRelation.year) relation.year = rawRelation.year;
        if (rawRelation.episode_count) relation.episodeCount = rawRelation.episode_count;
        return relation;
      });
      if (relations.length > 0) _jikanRelCache.set(malId, relations);
      return relations;
    } catch {
      
    }
  }
  return [];
}

export async function fetchAnimeFranchiseRelations(
  malId: number,
): Promise<AnimeRelation[]> {
  const visited = new Set<number>();
  const pending = [malId];
  const relations: AnimeRelation[] = [];

  while (pending.length > 0 && visited.size < 12) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const relation of await fetchAnimeRelations(current)) {
      if (
        !relations.some((candidate) => candidate.malId === relation.malId)
      ) {
        relations.push(relation);
      }
      if (
        !visited.has(relation.malId) &&
        (!relation.format || isTelevisionFormat(relation.format))
      ) {
        pending.push(relation.malId);
      }
    }
  }

  return relations;
}
