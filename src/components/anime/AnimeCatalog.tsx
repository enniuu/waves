import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import {
  buildAnimePlaybackUrl,
  fetchAnimeData,
  fetchAnimeFranchiseRelations,
  isAnimeMovieFormat,
  mergeAnimeFranchiseCandidates,
  mergeAnimeRelationSeasons,
  mergeAnimeEntries,
  resetAnimeCache,
  searchAnime,
  searchAnimeLocally,
  shouldBlockAnimeSeasonPicker,
  type AnimeEntry,
  type AnimeSeason,
} from "../../features/anime/anime.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import {
  mergeAnimeIds,
  normalizeAnimeIds,
  resolveAnimeIdentity,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import { animeViewSignal } from "../../core/ui/uiSignals.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { app } from "../../core/runtime/app.ts";
import { useDebouncedValue } from "../../hooks/useDebouncedValue.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import CatalogView from "../catalog/CatalogView.tsx";
import EpisodePickerModal from "./EpisodePickerModal.tsx";
import "../../assets/styles/catalog/catalog.css";
import "../../assets/styles/anime/anime.css";

const SVG_SUSHI = svgIcon("IconSushi", { size: 22, solid: true });

function needsAnimeFranchiseSearch(
  entry: AnimeEntry,
  seasons: readonly AnimeSeason[],
): boolean {
  if (!entry.ids?.anilist && !entry.ids?.mal) return false;
  if (seasons.length < 2) return false;
  return (
    !seasons.some((season) => season.number === 1) ||
    seasons.some((season) => season.year == null)
  );
}
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
const SEARCH_DEBOUNCE_MS = 120;

function animeCard(anime: AnimeEntry) {
  return { title: anime.title, cover: anime.posterUrl, smallCover: anime.posterSmallUrl,
    year: anime.year, rating: anime.rating, adult: anime.adult };
}

export default function AnimeCatalog({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [allAnime, setAllAnime] = useState<AnimeEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<AnimeEntry[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const [episodePickerVisible, setEpisodePickerVisible] = useState(false);
  const [episodePickerAnime, setEpisodePickerAnime] =
    useState<AnimeEntry | null>(null);
  const [episodePickerSeasonsLoading, setEpisodePickerSeasonsLoading] =
    useState(false);
  const [episodePickerEpisode, setEpisodePickerEpisode] = useState(0);
  const [episodePickerLanguage, setEpisodePickerLanguage] = useState<
    "sub" | "dub"
  >("sub");
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchRequestIdRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const episodePickerRequestIdRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const loadPendingRef = useRef(false);

  const loadAnime = useCallback(() => {
    if (loadPendingRef.current) return;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    loadPendingRef.current = true;
    setError(null);
    fetchAnimeData("anime", (anime) => {
      if (loadRequestIdRef.current !== requestId) return;
      setAllAnime(anime);
    })
      .then((anime) => {
        if (loadRequestIdRef.current !== requestId) return;
        setAllAnime(anime);
        setLoaded(true);
      })
      .catch(() => {
        if (loadRequestIdRef.current !== requestId) return;
        setError(negativeMessage("anime could not be loaded"));
        setLoaded(true);
      })
      .finally(() => {
        if (loadRequestIdRef.current === requestId) {
          loadPendingRef.current = false;
        }
      });
  }, []);

  const loadAnimeIfNeeded = useCallback(() => {
    if (!loaded || allAnime.length === 0) loadAnime();
  }, [allAnime.length, loadAnime, loaded]);

  const { visible, active, searchBarRef, show, hide } = useMenuView({
    bodyClass: "anime-view",
    signal: animeViewSignal,
    iconId: "anime-icon",
    inactiveIcon: SVG_SUSHI,
    activeIcon: SVG_SEARCH,
    openedStorageKey: "lyraUserOpenedAnimeMenu",
    oppositeBodyClass: "games-view",
    hideOpposite: () => window.hideGameMenu?.(),
    onShowFrame: loadAnimeIfNeeded,
    showOnMount: openOnMount,
  });

  const toggleAnime = useCallback(() => {
    if (document.body.classList.contains("anime-view")) hide();
    else show();
  }, [hide, show]);

  useEffect(() => {
    window.showAnimeMenu = show;
    window.hideAnimeMenu = hide;
    window.toggleAnimeMenu = toggleAnime;
    window.playNextEpisode = (request: {
      title: string;
      year?: number;
      anilistId?: number;
      malId?: number;
      ids?: AnimeIds;
      posterUrl: string;
      episodeCount?: number;
      format?: string;
      episode: number;
      language?: "sub" | "dub";
    }) => {
      show();
      setEpisodePickerEpisode(request.episode);
      setEpisodePickerLanguage(request.language === "dub" ? "dub" : "sub");
      setEpisodePickerSeasonsLoading(false);
      const ids = normalizeAnimeIds({
        ...request.ids,
        anilistId: request.anilistId,
        malId: request.malId,
      });
      setEpisodePickerAnime({
        id: ids.anilist || ids.mal || 0,
        title: request.title,
        year: request.year,
        posterUrl: request.posterUrl,
        anilistId: ids.anilist ? Number(ids.anilist) : undefined,
        malId: ids.mal ? Number(ids.mal) : undefined,
        ids,
        episodeCount: request.episodeCount,
        format: request.format,
        animeType: "anime",
      });
      setEpisodePickerVisible(true);
    };

    return () => {
      delete window.playNextEpisode;
    };
  }, [hide, show, toggleAnime]);

  useEffect(() => {
    searchRequestIdRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      searchRequestIdRef.current += 1;
      setSearching(false);
      setSearchResults([]);
      setSearchResultQuery("");
      return;
    }

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);

    searchAnime(debouncedQuery, controller.signal, (results) => {
      if (searchRequestIdRef.current !== requestId) return;
      setSearchResults(results);
      setSearchResultQuery(debouncedQuery.toLocaleLowerCase());
    })
      .then((results) => {
        if (searchRequestIdRef.current !== requestId) return;
        setSearchResults(results);
        setSearchResultQuery(debouncedQuery.toLocaleLowerCase());
        setSearching(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (searchRequestIdRef.current !== requestId) return;
        setSearching(false);
      });

    return () => {
      controller.abort();
      if (searchAbortRef.current === controller) searchAbortRef.current = null;
    };
  }, [debouncedQuery]);

  useEffect(() => {
    const handler = () => {
      resetAnimeCache();
      loadRequestIdRef.current += 1;
      loadPendingRef.current = false;
      searchRequestIdRef.current += 1;
      setAllAnime([]);
      setLoaded(false);
      setError(null);
      setQuery("");
      setSearchResults([]);
      setSearchResultQuery("");
      setSearching(false);
      loadAnime();
    };
    window.addEventListener("animeAdultChanged", handler);
    return () => {
      window.removeEventListener("animeAdultChanged", handler);
      loadRequestIdRef.current += 1;
      loadPendingRef.current = false;
    };
  }, [loadAnime]);

  const handlePlay = useCallback((anime: AnimeEntry) => {
    const pickerRequestId = episodePickerRequestIdRef.current + 1;
    episodePickerRequestIdRef.current = pickerRequestId;
    const initialIds = normalizeAnimeIds({
      ...anime.ids,
      anilistId: anime.anilistId,
      malId: anime.malId,
    });
    const initialAnime = { ...anime, ids: initialIds };
    if (isAnimeMovieFormat(anime.format)) {
      setEpisodePickerSeasonsLoading(false);
      setEpisodePickerVisible(false);
      hide();
      app().handleSearch?.(
        buildAnimePlaybackUrl({
          title: anime.title,
          posterUrl: anime.posterUrl,
          ids: initialIds,
          episode: 1,
          episodeCount: 1,
          year: anime.year,
          format: anime.format,
        }),
        anime.title,
        anime.posterUrl,
      );
      return;
    }
    setEpisodePickerEpisode(0);
    setEpisodePickerLanguage("sub");
    const initialSeasonSources = initialAnime.seasons || [];
    setEpisodePickerSeasonsLoading(
      shouldBlockAnimeSeasonPicker(
        Boolean(initialIds.mal),
        initialSeasonSources.length,
        needsAnimeFranchiseSearch(initialAnime, initialSeasonSources),
      ),
    );
    setEpisodePickerAnime(initialAnime);
    setEpisodePickerVisible(true);

    const isCurrentPicker = () =>
      episodePickerRequestIdRef.current === pickerRequestId;
    const addRelationSeasons = (malId?: string) => {
      const relationMalId = malId ? Number(malId) : 0;
      if (!Number.isInteger(relationMalId) || relationMalId <= 0) return;
      const relationEntry = {
        ...initialAnime,
        ids: mergeAnimeIds(initialAnime.ids, { mal: String(relationMalId) }),
      };
      const needsInitialSearch = needsAnimeFranchiseSearch(
        relationEntry,
        relationEntry.seasons || [],
      );
      if (
        relationEntry.seasons &&
        relationEntry.seasons.length > 1 &&
        !needsInitialSearch
      ) {
        return;
      }
      let franchiseSearchPromise: Promise<AnimeEntry[]> | null = null;
      const applyFranchiseSearch = (candidates: AnimeEntry[]) => {
        if (!isCurrentPicker() || candidates.length === 0) return;
        setEpisodePickerAnime((current) => {
          if (
            !isCurrentPicker() ||
            !current ||
            current.id !== initialAnime.id
          ) {
            return current;
          }
          return mergeAnimeFranchiseCandidates(current, candidates);
        });
      };
      const startFranchiseSearch = () => {
        if (!franchiseSearchPromise) {
          franchiseSearchPromise = searchAnime(
            relationEntry.title,
            undefined,
            applyFranchiseSearch,
            { forceRefresh: true },
          ).catch(() => [] as AnimeEntry[]);
        }
        return franchiseSearchPromise;
      };

      if (needsInitialSearch) {
        void startFranchiseSearch();
      }

      void fetchAnimeFranchiseRelations(relationMalId)
        .then((relations) => {
          if (!isCurrentPicker()) return;
          const relationSeasons = mergeAnimeRelationSeasons(
            relationEntry,
            relations,
          );
          const existingSeasons =
            relationSeasons.length > 1
              ? relationSeasons
              : relationEntry.seasons || [];

          setEpisodePickerAnime((current) => {
            if (
              !isCurrentPicker() ||
              !current ||
              current.id !== initialAnime.id
            ) {
              return current;
            }
            const currentRelationSeasons = mergeAnimeRelationSeasons(
              current,
              relations,
            );
            const relationEnriched =
              currentRelationSeasons.length > 1
                ? { ...current, seasons: currentRelationSeasons }
                : current;
            return relationEnriched;
          });
          const shouldWaitForSearch =
            franchiseSearchPromise !== null ||
            needsAnimeFranchiseSearch(relationEntry, existingSeasons);
          if (shouldWaitForSearch) {
            void startFranchiseSearch().then((candidates) => {
              applyFranchiseSearch(candidates);
              if (isCurrentPicker()) setEpisodePickerSeasonsLoading(false);
            });
          } else {
            setEpisodePickerSeasonsLoading(false);
          }
        })
        .catch(() => {
          if (isCurrentPicker()) setEpisodePickerSeasonsLoading(false);
        });
    };
    addRelationSeasons(initialIds.mal);

    
    
    void resolveAnimeIdentity({
      ids: initialIds,
      title: anime.title,
      year: anime.year,
      format: anime.format,
    }).then((identity) => {
      if (!identity || !isCurrentPicker()) return;
      if (!initialIds.mal) addRelationSeasons(identity.ids.mal);
      setEpisodePickerAnime((current) => {
        if (
          !isCurrentPicker() ||
          !current ||
          current.id !== initialAnime.id
        ) {
          return current;
        }
        const ids = mergeAnimeIds(current.ids, identity.ids);
        return {
          ...current,
          ids,
          anilistId: ids.anilist ? Number(ids.anilist) : current.anilistId,
          malId: ids.mal ? Number(ids.mal) : current.malId,
          episodeCount:
            current.episodeCount && current.episodeCount > 1
              ? current.episodeCount
              : identity.episodes || current.episodeCount,
          year: current.year || identity.year,
          format: current.format || identity.format,
        };
      });
    });
  }, [hide]);

  const handleEpisodePick = useCallback(
    (
      playerUrl: string,
      displayTitle: string,
      poster: string,
    ) => {
      setEpisodePickerVisible(false);
      hide();
      app().handleSearch?.(playerUrl, displayTitle, poster);
    },
    [hide],
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const localSearchResults = useMemo(
    () => searchAnimeLocally(allAnime, query),
    [allAnime, query],
  );
  const filteredAnime = useMemo(() => {
    if (!normalizedQuery) return allAnime;
    const remoteResults =
      searchResultQuery === normalizedQuery ? searchResults : [];
    return mergeAnimeEntries(remoteResults, localSearchResults);
  }, [
    allAnime,
    localSearchResults,
    normalizedQuery,
    searchResultQuery,
    searchResults,
  ]);

  const placeholder = loaded
    ? "search for any anime... ◝(ᵔᗜᵔ)◜"
    : "fetching anime...";

  const isSearchActive = query.trim().length > 0;
  const searchPending =
    isSearchActive &&
    (searching || debouncedQuery.toLocaleLowerCase() !== normalizedQuery);
  const showSkeleton =
    (!isSearchActive && !loaded && allAnime.length === 0) ||
    (searchPending && filteredAnime.length === 0);
  const feedPending = !isSearchActive && !loaded && allAnime.length > 0;

  return (
    <>
      <CatalogView
        id="anime-page"
        className="anime-page"
        topbarClassName="anime-topbar"
        searchBarClassName="anime-search-bar"
        searchIconClassName="anime-search-icon"
        inputId="mediaSearchInput"
        gridContainerClassName="anime-grid-container"
        gridClassName="anime-grid"
        visible={visible}
        active={active}
        searchBarRef={searchBarRef}
        query={query}
        placeholder={placeholder}
        onQueryChange={setQuery}
        gridVisible={filteredAnime.length > 0}
        showSkeleton={showSkeleton}
        items={filteredAnime}
        getCard={animeCard}
        onSelect={handlePlay}
        anime
        emptyMessage={
          loaded && !searchPending && filteredAnime.length === 0
            ? error || negativeMessage("no anime matches were found")
            : null
        }
        statusMessage={
          searchPending
            ? "searching anime..."
            : feedPending
              ? "fetching more anime..."
              : null
        }
      />

      {episodePickerAnime && (
        <EpisodePickerModal
          key={`${episodePickerAnime.animeType}-${episodePickerAnime.id}`}
          visible={episodePickerVisible}
          title={episodePickerAnime.title}
          year={episodePickerAnime.year}
          type={episodePickerAnime.animeType}
          ids={episodePickerAnime.ids}
          seasons={episodePickerAnime.seasons}
          seasonsLoading={episodePickerSeasonsLoading}
          anilistId={episodePickerAnime.anilistId}
          malId={episodePickerAnime.malId}
          posterUrl={episodePickerAnime.posterUrl}
          episodeCount={episodePickerAnime.episodeCount}
          format={episodePickerAnime.format}
          initialEpisode={episodePickerEpisode}
          initialLanguage={episodePickerLanguage}
          onClose={() => {
            setEpisodePickerVisible(false);
          }}
          onPlay={handleEpisodePick}
        />
      )}
    </>
  );
}
