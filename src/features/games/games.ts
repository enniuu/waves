import { encodeMochiUrl, normalizeGameHistoryUrl } from "../../core/runtime/utils.ts";
import {
  getStoredGameSource,
  type GameSourceKey,
} from "../../core/config/settingsOptions.ts";
import { registerGameMetadataProvider } from "../../core/media/gameMetadata.ts";
import { recordGameMetric } from "../../core/media/gameDiagnostics.ts";
import { NEGATIVE, negativeMessage } from "../../core/runtime/messages.ts";
import { cacheKey } from "../../core/runtime/cacheNamespace.ts";
import { catalogMatchRank, normalizeCatalogText } from "./catalogSearch.ts";
import {
  GAME_SOURCE_ADAPTERS,
  GameCatalogError,
  gameCatalogErrorMessage,
  parseGameCatalog,
} from "./gameSources.ts";
import type { GameEntry } from "./gameSources.ts";

export type { GameEntry } from "./gameSources.ts";

const GAME_CACHE_KEY_PREFIX = "lyra-game-cache";
const EDUROCKS_CACHE_REVISION = "codec-v2";
const GAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GAME_CACHE_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_REQUEST_TIMEOUT_MS = 8_000;
const CATALOG_REQUEST_DEADLINE_MS = 18_000;
const CATALOG_MAX_ATTEMPTS = 3;
const CATALOG_MAX_BYTES = 4 * 1024 * 1024;

class GameCatalogCancelledError extends Error {
  constructor() {
    super(negativeMessage("catalog request cancelled"));
    this.name = "AbortError";
  }
}

class CatalogBodyTooLargeError extends Error {
  constructor() {
    super(negativeMessage("catalog response is too large"));
    this.name = "CatalogBodyTooLargeError";
  }
}

interface StoredGameCache {
  expiresAt: number;
  staleUntil?: number;
  games: GameEntry[];
}

type MemoryGameCache = {
  expiresAt: number;
  staleUntil: number;
  games: GameEntry[];
};

type CachedGames = MemoryGameCache & { fresh: boolean };

let allGames: GameEntry[] = [];
let allGamesSource: GameSourceKey | null = null;
export { allGames };
const inFlightBySource = new Map<
  GameSourceKey,
  { promise: Promise<GameEntry[]>; controller: AbortController }
>();
const memoryCacheBySource = new Map<GameSourceKey, MemoryGameCache>();
const generationBySource = new Map<GameSourceKey, number>();
let gameByExactUrl = new Map<string, GameEntry>();
let gameByNormalizedUrl = new Map<string, GameEntry>();
let gnMathById = new Map<string, GameEntry>();

function now(): number {
  return Date.now();
}

function getCacheKey(sourceKey: GameSourceKey): Promise<string> {
  const discriminator =
    sourceKey === "edurocks"
      ? `${sourceKey}-${EDUROCKS_CACHE_REVISION}`
      : sourceKey;
  return cacheKey(GAME_CACHE_KEY_PREFIX, import.meta.url, discriminator);
}

function currentGeneration(source: GameSourceKey): number {
  return generationBySource.get(source) ?? 0;
}

function prepareCatalogGames(games: readonly GameEntry[]): GameEntry[] {
  const seenUrls = new Set<string>();
  const uniqueGames: GameEntry[] = [];
  for (const game of games) {
    if (seenUrls.has(game.gameUrl)) continue;
    seenUrls.add(game.gameUrl);
    game._normalizedName = normalizeCatalogText(game.name || "");
    game._normalizedAuthor = normalizeCatalogText(game.author || "");
    uniqueGames.push(game);
  }
  return uniqueGames;
}

function isSafeCatalogUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSafeCatalogCover(value: string): boolean {
  if (!value) return true;
  if (value.startsWith("/!cover!/") || value.startsWith("/!!/")) return true;
  return isSafeCatalogUrl(value);
}

function isStoredGame(value: unknown, source: GameSourceKey): value is GameEntry {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<GameEntry>;
  return (
    (typeof game.id === "string" || typeof game.id === "number") &&
    typeof game.name === "string" &&
    game.name.length > 0 &&
    typeof game.coverUrl === "string" &&
    isSafeCatalogCover(game.coverUrl) &&
    typeof game.gameUrl === "string" &&
    isSafeCatalogUrl(game.gameUrl) &&
    typeof game.isExternal === "boolean" &&
    typeof game.featured === "boolean" &&
    game.sourceKey === source
  );
}

async function readStoredCache(source: GameSourceKey): Promise<CachedGames | null> {
  const inMemory = memoryCacheBySource.get(source);
  if (inMemory) {
    if (inMemory.staleUntil <= now()) {
      memoryCacheBySource.delete(source);
    } else {
      return { ...inMemory, fresh: inMemory.expiresAt > now() };
    }
  }

  try {
    const cacheKey = await getCacheKey(source);
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    if (raw.length > CATALOG_MAX_BYTES) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    const stored = JSON.parse(raw) as Partial<StoredGameCache>;
    const staleUntil =
      typeof stored.staleUntil === "number"
        ? stored.staleUntil
        : typeof stored.expiresAt === "number"
          ? stored.expiresAt + GAME_CACHE_STALE_TTL_MS
          : 0;
    if (
      !Array.isArray(stored.games) ||
      !stored.games.every((game) => isStoredGame(game, source)) ||
      staleUntil <= now()
    ) {
      localStorage.removeItem(cacheKey);
      return null;
    }

    const games = prepareCatalogGames(stored.games);
    const cache: MemoryGameCache = {
      expiresAt: typeof stored.expiresAt === "number" ? stored.expiresAt : 0,
      staleUntil,
      games,
    };
    memoryCacheBySource.set(source, cache);
    return { ...cache, fresh: cache.expiresAt > now() };
  } catch {
    return null;
  }
}

function setAllGames(source: GameSourceKey, games: GameEntry[]): GameEntry[] {
  allGames = games;
  allGamesSource = source;
  gameByExactUrl = new Map();
  gameByNormalizedUrl = new Map();
  gnMathById = new Map();

  for (const game of games) {
    if (game.gameUrl) {
      gameByExactUrl.set(game.gameUrl, game);
      const normalized = normalizeGameHistoryUrl(game.gameUrl);
      if (normalized) gameByNormalizedUrl.set(normalized, game);
    }
    if (game.sourceKey === "gn-math") {
      const id = String(game.id);
      gnMathById.set(id, game);
      try {
        gnMathById.set(decodeURIComponent(id), game);
      } catch {}
    }
  }

  try {
    const lyra = (window as unknown as {
      Lyra?: { allGames?: GameEntry[] };
    }).Lyra;
    if (lyra) {
      if (Array.isArray(lyra.allGames)) {
        lyra.allGames.splice(0, lyra.allGames.length, ...games);
      } else {
        lyra.allGames = games;
      }
    }
  } catch {}

  return games;
}

function notifyCatalogUpdated(source: GameSourceKey, games: GameEntry[]): void {
  try {
    window.dispatchEvent(
      new CustomEvent("lyra:game-catalog-updated", {
        detail: { source, games },
      }),
    );
  } catch {}
}

export function searchGames(
  games: readonly GameEntry[],
  query: string,
): GameEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return games as GameEntry[];

  const tokens = normalizedQuery.split(" ");
  const ranked: GameEntry[][] = [[], [], [], [], []];
  for (const game of games) {
    const rank = catalogMatchRank(
      game._normalizedName ?? normalizeCatalogText(game.name),
      game._normalizedAuthor ?? normalizeCatalogText(game.author || ""),
      normalizedQuery,
      tokens,
    );
    if (rank >= 0) ranked[rank]!.push(game);
  }
  return ranked.flat();
}

async function saveToCache(source: GameSourceKey, games: GameEntry[]): Promise<GameEntry[]> {
  const timestamp = now();
  const cache: MemoryGameCache = {
    expiresAt: timestamp + GAME_CACHE_TTL_MS,
    staleUntil: timestamp + GAME_CACHE_STALE_TTL_MS,
    games,
  };
  memoryCacheBySource.set(source, cache);

  try {
    const stored: StoredGameCache = {
      expiresAt: cache.expiresAt,
      staleUntil: cache.staleUntil,
      games,
    };
    localStorage.setItem(await getCacheKey(source), JSON.stringify(stored));
  } catch (error) {
    console.warn("unable to cache games:", error, NEGATIVE);
  }
  return games;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 1_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCatalogBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      throw new CatalogBodyTooLargeError();
    }
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new CatalogBodyTooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function fetchCatalogPayload(
  source: GameSourceKey,
  requestSignal?: AbortSignal,
): Promise<{ payload: unknown; attempts: number }> {
  const adapter = GAME_SOURCE_ADAPTERS[source];
  const deadline = now() + CATALOG_REQUEST_DEADLINE_MS;
  let lastError: GameCatalogError | null = null;

  for (let attempt = 1; attempt <= CATALOG_MAX_ATTEMPTS; attempt += 1) {
    if (requestSignal?.aborted) throw new GameCatalogCancelledError();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(CATALOG_REQUEST_TIMEOUT_MS, remaining),
    );
    const abortRequest = () => controller.abort();
    requestSignal?.addEventListener("abort", abortRequest, { once: true });

    try {
      const response = await fetch(adapter.catalogUrl, {
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        const error = new GameCatalogError("catalog request failed", {
          kind: isRetryableStatus(response.status)
            ? "temporary-source"
            : "unavailable",
          source,
          status: response.status,
          attempts: attempt,
        });
        lastError = error;
        if (!isRetryableStatus(response.status)) throw error;
        if (attempt < CATALOG_MAX_ATTEMPTS && now() < deadline) {
          await wait(Math.min(retryDelay(attempt), Math.max(0, deadline - now())));
          continue;
        }
        throw error;
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > CATALOG_MAX_BYTES) {
        throw new GameCatalogError("catalog response is too large", {
          kind: "upstream-data",
          source,
          attempts: attempt,
        });
      }

      let body: string;
      try {
        body = await readCatalogBody(response, CATALOG_MAX_BYTES);
      } catch (error) {
        if (error instanceof CatalogBodyTooLargeError) {
          throw new GameCatalogError("catalog response is too large", {
            kind: "upstream-data",
            source,
            attempts: attempt,
          });
        }
        throw error;
      }
      try {
        const payload = adapter.parseResponse
          ? await adapter.parseResponse(body, controller.signal)
          : JSON.parse(body);
        return { payload, attempts: attempt };
      } catch (error) {
        throw new GameCatalogError("catalog response could not be parsed", {
          kind: "upstream-data",
          source,
          attempts: attempt,
          cause: error,
        });
      }
    } catch (error) {
      if (requestSignal?.aborted) throw new GameCatalogCancelledError();
      if (error instanceof GameCatalogError) {
        lastError = error;
        if (
          (error.kind !== "temporary-source" && error.kind !== "network") ||
          attempt >= CATALOG_MAX_ATTEMPTS ||
          now() >= deadline
        ) {
          throw error;
        }
      } else {
        lastError = new GameCatalogError("catalog network request failed", {
          kind: "network",
          source,
          attempts: attempt,
          cause: error,
        });
        if (attempt >= CATALOG_MAX_ATTEMPTS || now() >= deadline) throw lastError;
      }
      if (attempt < CATALOG_MAX_ATTEMPTS && now() < deadline) {
        await wait(Math.min(retryDelay(attempt), Math.max(0, deadline - now())));
      }
    } finally {
      clearTimeout(timeout);
      requestSignal?.removeEventListener("abort", abortRequest);
    }
  }

  throw (
    lastError ??
    new GameCatalogError("catalog request deadline exceeded", {
      kind: "network",
      source,
      attempts: CATALOG_MAX_ATTEMPTS,
    })
  );
}

function beginNetworkFetch(source: GameSourceKey): Promise<GameEntry[]> {
  const existing = inFlightBySource.get(source);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const generation = currentGeneration(source);
  const startedAt = typeof performance === "undefined" ? now() : performance.now();
  const request = fetchCatalogPayload(source, controller.signal)
    .then(async ({ payload, attempts }) => {
      let games: GameEntry[];
      try {
        games = prepareCatalogGames(parseGameCatalog(source, payload));
      } catch (error) {
        if (error instanceof GameCatalogError) {
          throw new GameCatalogError(error.message, {
            kind: error.kind,
            source,
            attempts,
            ...(error.status === undefined ? {} : { status: error.status }),
            cause: error,
          });
        }
        throw error;
      }
      if (generation === currentGeneration(source)) {
        await saveToCache(source, games);
        if (getStoredGameSource() === source) {
          setAllGames(source, games);
          notifyCatalogUpdated(source, games);
        }
      }
      recordGameMetric({
        stage: "catalog",
        source,
        cache: "network",
        status: "success",
        durationMs:
          (typeof performance === "undefined" ? now() : performance.now()) -
          startedAt,
        games: games.length,
        attempts,
      });
      return games;
    })
    .catch((error) => {
      if (error instanceof GameCatalogCancelledError) throw error;
      const normalized =
        error instanceof GameCatalogError
          ? error
          : new GameCatalogError("catalog processing failed", {
              kind: "implementation",
              source,
              cause: error,
            });
      recordGameMetric({
        stage: "catalog",
        source,
        cache: "error",
        status: "error",
        durationMs:
          (typeof performance === "undefined" ? now() : performance.now()) -
          startedAt,
        ...(normalized.attempts === undefined
          ? {}
          : { attempts: normalized.attempts }),
        errorKind: normalized.kind,
      });
      console.error("game catalog failure", {
        source,
        kind: normalized.kind,
        status: normalized.status,
        attempts: normalized.attempts,
      }, NEGATIVE);
      throw normalized;
    });

  void request
    .finally(() => {
      if (inFlightBySource.get(source)?.promise === request) {
        inFlightBySource.delete(source);
      }
    })
    .catch(() => undefined);
  inFlightBySource.set(source, { promise: request, controller });
  return request;
}

export async function fetchGameData(
  options: { forceRefresh?: boolean } = {},
): Promise<GameEntry[]> {
  const source = getStoredGameSource();
  const cached = options.forceRefresh ? null : await readStoredCache(source);
  if (cached) {
    setAllGames(source, cached.games);
    recordGameMetric({
      stage: "catalog",
      source,
      cache: cached.fresh ? "fresh-local" : "stale-local",
      status: "success",
      durationMs: 0,
      games: cached.games.length,
    });
    if (cached.fresh) return Promise.resolve(cached.games);

    const refresh = beginNetworkFetch(source);
    void refresh.catch(() => undefined);
    return Promise.resolve(cached.games);
  }

  return beginNetworkFetch(source);
}

export function resetGameCache(): void {
  const source = getStoredGameSource();
  generationBySource.set(source, currentGeneration(source) + 1);
  memoryCacheBySource.delete(source);
  inFlightBySource.get(source)?.controller.abort();
  inFlightBySource.delete(source);
  setAllGames(source, []);
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${GAME_CACHE_KEY_PREFIX}-`)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}

export function getGameEntryForUrl(realUrl: string): GameEntry | null {
  if (!realUrl || !allGames.length || allGamesSource !== getStoredGameSource()) return null;

  const exact = gameByExactUrl.get(realUrl);
  if (exact) return exact;

  const normalized = normalizeGameHistoryUrl(realUrl);
  const normalizedMatch = normalized
    ? gameByNormalizedUrl.get(normalized)
    : null;
  if (normalizedMatch) return normalizedMatch;

  try {
    const url = new URL(realUrl);
    if (!url.hostname.includes("gn-math.dev")) return null;
    const id = url.searchParams.get("id");
    if (!id) return null;

    const rawId = String(id).trim();
    const decodedId = decodeURIComponent(rawId);
    const direct = gnMathById.get(rawId) || gnMathById.get(decodedId);
    if (direct) return direct;

    const numericId = rawId.match(/\d+/)?.[0];
    return numericId ? gnMathById.get(numericId) || null : null;
  } catch {
    return null;
  }
}

export function getGameCoverForUrl(realUrl: string): string | null {
  const match = getGameEntryForUrl(realUrl);
  if (!match?.coverUrl) return null;
  return match.coverUrl.startsWith("/")
    ? match.coverUrl
    : `/!cover!/${encodeMochiUrl(match.coverUrl)}/`;
}

export function getGameDisplayLabel(realUrl: string): string | null {
  try {
    const match = getGameEntryForUrl(realUrl);
    if (!match) return null;
    const sourceKey = (
      match.sourceKey || getStoredGameSource()
    ).toLowerCase();
    return `game: ${String(match.name || match.id || realUrl).toLowerCase()} / source: ${sourceKey}`;
  } catch {
    return null;
  }
}

export { gameCatalogErrorMessage };

registerGameMetadataProvider({
  getCover: getGameCoverForUrl,
  getDisplayLabel: getGameDisplayLabel,
});
