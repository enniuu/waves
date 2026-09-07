import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import Hls from "hls.js";
import { showToast } from "../../core/ui/toast.ts";
import { recordStreamDiagnostic } from "../../core/media/streamDiagnostics.ts";
import {
  PLAYER_SIZE_ABR_CONFIG,
  applyQualitySelection,
  preferredQualityLevel,
  qualityMenuLabel,
} from "../../core/media/hlsQuality.ts";
import { negativeMessage, RequestError } from "../../core/runtime/messages.ts";
import {
  readMediaState,
  type MediaState,
  type MediaStateHints,
} from "../../core/media/mediaState.ts";
import {
  fetchAnimeEpisodeCount,
  isAnimeMovieFormat,
} from "../../features/anime/anime.ts";
import {
  ANIME_QUALITY_KEY,
  ANIME_SETTING_KEYS,
  readAnimeQuality,
  readAnimeSetting,
} from "../../core/media/animeSettings.ts";
import {
  animeIdentityCacheKey,
  appendMegaPlayParams,
  hasMegaPlayIdentifier,
  normalizeAnimeIds,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import {
  IconCheckCircle2,
  IconChevronBottom,
  IconBubbleText,
  IconPlay,
  IconPause,
  IconBack10s,
  IconForwards10s,
  IconVolumeFull,
  IconVolumeHalf,
  IconVolumeMinimum,
  IconVolumeOff,
  IconFullScreen,
  IconDownsize,
} from "../icons";

const STREAM_INFO_TIMEOUT_MS = 12_000;
const SUBTITLE_PREFERENCE_KEY = "lyra-anime-subtitle";

interface StreamSubtitleTrack {
  label: string;
  language: string;
  src: string;
  kind?: "subtitles" | "captions" | string;
  default?: boolean;
}

interface StreamQualityOption {
  index: number;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}

interface StreamAudioTrack {
  label: string;
  language: string;
  default?: boolean;
}

interface StreamInfoResponse {
  duration?: number | null;
  needs_transmux?: boolean;
  hls?: boolean;
  tracks?: StreamSubtitleTrack[];
  audio_tracks?: StreamAudioTrack[];
  source?: {
    id?: string;
    server?: number | string;
    language?: "sub" | "dub" | string | null;
    url?: string;
  };
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
  qualities?: Array<{
    index: number;
    width?: number;
    height?: number;
    bitrate?: number;
    codecs?: string;
  }>;
}

type PlayerStatus =
  | "idle"
  | "loading"
  | "buffering"
  | "waiting"
  | "stalled"
  | "playing"
  | "paused"
  | "ended"
  | "error";

interface PlaybackEpisodePartRange {
  start: number;
  end: number;
  ids: AnimeIds;
}

function mergeEpisodeCount(...counts: number[]): number {
  return counts.reduce(
    (largest, count) =>
      Number.isInteger(count) && count > largest ? count : largest,
    0,
  );
}

function resolvePlayerStatus(
  status: PlayerStatus,
  hasSource: boolean,
  detailsLoading: boolean,
): PlayerStatus {
  if (!hasSource) return "idle";
  if (status === "error") return status;
  return detailsLoading ? "loading" : status;
}

function parsePlaybackEpisodeParts(value: string | null): PlaybackEpisodePartRange[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as {
        start?: unknown;
        end?: unknown;
        ids?: unknown;
      };
      const start = Number(candidate.start);
      const end = Number(candidate.end);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        !candidate.ids ||
        typeof candidate.ids !== "object"
      ) {
        return [];
      }
      return [{ start, end, ids: normalizeAnimeIds(candidate.ids as AnimeIds) }];
    });
  } catch {
    return [];
  }
}

async function fetchStreamInfo(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<StreamInfoResponse> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "stream information request timed out... /ᐠ - ˕ -マ",
          "TimeoutError",
        ),
      ),
    STREAM_INFO_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`/stream/info?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RequestError("stream information request failed", {
        code: "STREAM_INFO_UNAVAILABLE",
        status: response.status,
      });
    }
    return (await response.json()) as StreamInfoResponse;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new RequestError("stream information request timed out", {
        code: "STREAM_INFO_TIMEOUT",
      });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const formattedMinutes = minutes.toString().padStart(2, "0");
  const formattedSeconds = remainingSeconds.toString().padStart(2, "0");

  return hours > 0
    ? `${hours}:${formattedMinutes}:${formattedSeconds}`
    : `${minutes}:${formattedSeconds}`;
}

function cleanDuration(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function hasBufferedTime(video: HTMLVideoElement, seconds: number): boolean {
  for (let i = 0; i < video.buffered.length; i++) {
    if (
      seconds >= video.buffered.start(i) - 0.25 &&
      seconds <= video.buffered.end(i) + 0.25
    ) {
      return true;
    }
  }
  return false;
}

function buildNextEpisodeStreamUrl(
  episode: number,
  episodeParts: PlaybackEpisodePartRange[],
  identityIds: AnimeIds,
  language: "sub" | "dub",
): string {
  const part = episodeParts.find(
    (candidate) => episode >= candidate.start && episode <= candidate.end,
  );
  const sourceEpisode = part ? episode - part.start + 1 : episode;
  const ids = normalizeAnimeIds({
    ...(part?.ids || identityIds),
    anikotoEpisode: undefined,
  });
  if (!hasMegaPlayIdentifier(ids)) return "";
  const query = new URLSearchParams({
    episode: String(sourceEpisode),
    language,
  });
  appendMegaPlayParams(query, ids);
  return `/stream/anikoto?${query}`;
}

function cueTextToPlainText(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = value.replace(/<br\s*\/?>/gi, "\n");
  return template.content.textContent?.trim() || "";
}

function subtitlePreference(track: StreamSubtitleTrack): string {
  return `${track.language || "und"}|${track.label}`.toLowerCase();
}

function isEnglishSubtitle(track: StreamSubtitleTrack): boolean {
  const language = track.language.trim().toLowerCase();
  const label = track.label.trim().toLowerCase();
  return (
    language === "en" ||
    language.startsWith("en-") ||
    /\benglish\b|\beng\b/.test(label)
  );
}

function qualityLabel(height: number, bitrate: number): string {
  if (height > 0) {
    const rate = bitrate > 0 ? ` · ${(bitrate / 1_000_000).toFixed(1)} mbps` : "";
    return `${height}p${rate}`;
  }
  return bitrate > 0 ? `${(bitrate / 1_000_000).toFixed(1)} mbps` : "source";
}

function qualityName(label: string | undefined): string {
  return label?.split(" · ", 1)[0] || "source";
}

function hlsLoadPolicy(
  maxTimeToFirstByteMs: number,
  maxLoadTimeMs: number,
  timeoutRetries: number,
  errorRetries: number,
) {
  return {
    default: {
      maxTimeToFirstByteMs,
      maxLoadTimeMs,
      timeoutRetry: {
        maxNumRetry: timeoutRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 4_000,
        backoff: "exponential" as const,
      },
      errorRetry: {
        maxNumRetry: errorRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 5_000,
        backoff: "exponential" as const,
      },
    },
  };
}


export default function Player() {
  const params = useRef(new URLSearchParams(window.location.search)).current;
  const title = params.get("title") || "";
  const poster = params.get("poster") || "";
  const hasEpisodeParam = params.has("episode");
  const initialEpisode = parseInt(params.get("episode") || "0", 10);
  const anilistId = parseInt(params.get("anilist_id") || "0", 10);
  const malId = parseInt(params.get("mal_id") || "0", 10);
  const anikotoEpisodeId = params.get("anikoto_episode_id") || "";
  const identityIds = useMemo(
    () => normalizeAnimeIds({
      anilist: anilistId,
      mal: malId,
      anikotoEpisode: anikotoEpisodeId,
    }),
    [anilistId, malId, anikotoEpisodeId],
  );
  const episodeParts = useMemo(
    () => parsePlaybackEpisodeParts(params.get("episode_parts")),
    [params],
  );
  const initialPart = episodeParts.find(
    (part) => initialEpisode >= part.start && initialEpisode <= part.end,
  );
  const initialSourceEpisode = parseInt(
    params.get("source_episode") ||
      String(initialEpisode || (anikotoEpisodeId ? 1 : 0)),
    10,
  );
  const initialLanguage = params.get("language") === "dub" ? "dub" : "sub";
  const [language, setLanguage] = useState<"sub" | "dub">(initialLanguage);
  const [activeAnikotoEpisodeId, setActiveAnikotoEpisodeId] = useState(
    anikotoEpisodeId,
  );
  const [activePartRange, setActivePartRange] =
    useState<PlaybackEpisodePartRange | null>(initialPart || null);
  const [activePartIds, setActivePartIds] = useState<AnimeIds>(
    initialPart?.ids || identityIds,
  );
  const [episodeOffset, setEpisodeOffset] = useState(
    initialPart ? initialPart.start - 1 : Math.max(0, initialEpisode - initialSourceEpisode),
  );
  const playbackIds = useMemo(
    () => normalizeAnimeIds({
      ...(activePartRange ? activePartIds : identityIds),
      anikotoEpisode: activeAnikotoEpisodeId,
    }),
    [identityIds, activePartRange, activePartIds, activeAnikotoEpisodeId],
  );
  const initialEpisodeCount = parseInt(params.get("episode_count") || "0", 10);
  const format = params.get("format") || "";
  const [episodeNumber, setEpisodeNumber] = useState(
    hasEpisodeParam ? Math.max(0, initialEpisode) : anikotoEpisodeId ? 1 : 0,
  );
  const [confirmedEpisodeNumber, setConfirmedEpisodeNumber] = useState<number | null>(
    null,
  );
  const sourceEpisodeNumber = Math.max(
    0,
    episodeNumber - (activePartRange ? activePartRange.start - 1 : episodeOffset),
  );
  const [episodeCount, setEpisodeCount] = useState(
    mergeEpisodeCount(initialEpisodeCount, initialEpisode),
  );
  const fallbackQuery = new URLSearchParams({
    episode: String(sourceEpisodeNumber),
    language,
  });
  appendMegaPlayParams(fallbackQuery, playbackIds);
  const baseVideoSrc =
    (episodeNumber > 0 || Boolean(playbackIds.anikotoEpisode)) &&
    hasMegaPlayIdentifier(playbackIds)
      ? `/stream/anikoto?${fallbackQuery}`
      : "";
  const resumeKey = `lyra-resume-anikoto-${animeIdentityCacheKey({ ids: playbackIds })}-${episodeNumber}-${language}`;
  const sourceContextKey = [
    episodeNumber,
    sourceEpisodeNumber,
    language,
    playbackIds.anilist || 0,
    playbackIds.mal || 0,
    playbackIds.anikotoEpisode || "",
  ].join("|");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsSessionRef = useRef(0);
  const mediaSessionRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNextTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nativeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const retryCountRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const sourceSwitchTimeRef = useRef<number | null>(null);
  const streamStartRef = useRef(0);
  const playAfterSeekRef = useRef(true);
  const playIntentRef = useRef(true);
  const playRequestRef = useRef(0);
  const sourceContextGenerationRef = useRef(0);
  const sourceContextRef = useRef(sourceContextKey);
  sourceContextRef.current = sourceContextKey;
  const resumeAppliedRef = useRef(false);
  const currentTimeRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef(performance.now());
  const firstSegmentRecordedRef = useRef(false);
  const firstFrameRecordedRef = useRef(false);
  const rebufferStartedAtRef = useRef<number | null>(null);
  const rebufferCountRef = useRef(0);
  const totalRebufferDurationMsRef = useRef(0);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const progressThumbRef = useRef<HTMLDivElement | null>(null);
  const timeDisplayRef = useRef<HTMLDivElement | null>(null);
  const seekBarRef = useRef<HTMLDivElement | null>(null);
  const seekPreviewRef = useRef<HTMLDivElement | null>(null);
  const seekHoverFrameRef = useRef<number | null>(null);
  const seekHoverClientXRef = useRef(0);
  const seekRectRef = useRef<DOMRect | null>(null);
  const controlsFrameRef = useRef<number | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>(() => {
    const storedVolumeValue = localStorage.getItem("lyra-anime-volume");
    const storedVolume =
      storedVolumeValue === null ? Number.NaN : Number(storedVolumeValue);
    const initialVolume = Number.isFinite(storedVolume)
      ? Math.max(0, Math.min(100, storedVolume))
      : 100;
    return {
      status: "loading",
      sourceReady: false,
      buffering: Boolean(baseVideoSrc),
      bufferingReason: baseVideoSrc ? "waiting" : null,
      playing: false,
      paused: true,
      ended: false,
      seeking: false,
      currentTime: null,
      duration: null,
      progress: null,
      buffered: [],
      volume: initialVolume,
      muted: false,
      playbackRate: 1,
      renderedWidth: 0,
      renderedHeight: 0,
      readyState: 0,
      networkState: 0,
      error: null,
    };
  });
  const mediaStateRef = useRef(mediaState);
  const mediaHintsRef = useRef<MediaStateHints>({
    sourceReady: false,
    buffering: Boolean(baseVideoSrc),
    bufferingReason: baseVideoSrc ? "waiting" : null,
    error: null,
    durationHint: null,
    logicalOffset: 0,
  });
  const manifestDurationRef = useRef<number | null>(null);
  const sourceGenerationRef = useRef(0);
  const [confirmedLanguage, setConfirmedLanguage] = useState<"sub" | "dub" | null>(
    null,
  );
  const [introMarker, setIntroMarker] = useState<
    { start: number; end: number } | null
  >(null);
  const [outroMarker, setOutroMarker] = useState<
    { start: number; end: number } | null
  >(null);
  const [isFullscreen, setIsFullscreen] = useState(() =>
    Boolean(document.fullscreenElement),
  );
  const [showControls, setShowControls] = useState(true);
  const [subtitleTracks, setSubtitleTracks] = useState<StreamSubtitleTrack[]>(
    [],
  );
  const [selectedSubtitle, setSelectedSubtitle] = useState(-1);
  const [qualityOptions, setQualityOptions] = useState<StreamQualityOption[]>(
    [],
  );
  const [selectedQuality, setSelectedQuality] = useState(-1);
  const [activeQuality, setActiveQuality] = useState(-1);
  const [autoQuality, setAutoQuality] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<StreamAudioTrack[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  const [activeSubtitle, setActiveSubtitle] = useState(-1);
  const [autoNext, setAutoNext] = useState<{
    episode: number;
    seconds: number;
  } | null>(null);
  const [autoPlayNextEpisode, setAutoPlayNextEpisode] = useState(() =>
    readAnimeSetting("autoPlayNextEpisode"),
  );
  const [autoSkipIntroOutro, setAutoSkipIntroOutro] = useState(() =>
    readAnimeSetting("autoSkipIntroOutro"),
  );
  const autoSkippedMarkerRef = useRef<string | null>(null);
  const lastSubtitleRef = useRef(0);
  const subtitlePreferenceRef = useRef(
    localStorage.getItem(SUBTITLE_PREFERENCE_KEY) || "",
  );
  const lastSubtitlePreferenceRef = useRef(
    subtitlePreferenceRef.current === "off"
      ? ""
      : subtitlePreferenceRef.current,
  );
  const [openSelector, setOpenSelector] = useState<
    "episodes" | "language" | "subtitles" | "quality" | "audio" | null
  >(null);
  const [changingLanguage, setChangingLanguage] = useState(false);
  const [loadingEpisodeCount, setLoadingEpisodeCount] = useState(false);
  const [loadingStreamInfo, setLoadingStreamInfo] = useState(false);
  const selectorOpenRef = useRef(false);
  const reportPlayerStatus = useCallback((status: PlayerStatus) => {
    try {
      const parentLyra = window.parent?.Lyra;
      const tabId = parentLyra?.tabs?.find(
        (tab) => tab.iframe?.contentWindow === window,
      )?.id;
      if (typeof tabId === "number") {
        parentLyra?.setPlayerStatus?.(tabId, status);
      }
    } catch {
      
    }
  }, []);
  const [showKeys, setShowKeys] = useState(false);

  const captionRef = useRef<HTMLDivElement | null>(null);
  const captionTrackRef = useRef<TextTrack | null>(null);
  const captionChangeRef = useRef<(() => void) | null>(null);
  const [needsTransmux, setNeedsTransmux] = useState(false);
  const needsRestartSeek = needsTransmux;
  const videoSrc = baseVideoSrc;
  const displayDuration = mediaState.duration ?? 0;
  const buffering = mediaState.buffering;
  const loading = mediaState.status === "loading";
  const loadError = mediaState.error || "";
  const volume = mediaState.volume;
  const muted = mediaState.muted;
  const rate = mediaState.playbackRate;
  const durationLabel =
    displayDuration > 0 ? formatTime(displayDuration) : "--:--";
  const displayDurationRef = useRef(displayDuration);
  const durationLabelRef = useRef(durationLabel);
  displayDurationRef.current = displayDuration;
  durationLabelRef.current = durationLabel;

  const syncMediaState = useCallback((patch: MediaStateHints = {}) => {
    mediaHintsRef.current = { ...mediaHintsRef.current, ...patch };
    const video = videoRef.current;
    if (!video) return;
    const next = readMediaState(video, mediaHintsRef.current);
    mediaStateRef.current = next;
    setMediaState(next);
  }, []);

  const renderPlaybackTime = useCallback(
    (value: number | null) => {
      const time =
        value !== null && Number.isFinite(value) ? Math.max(0, value) : null;
      const duration = displayDurationRef.current;
      const pct =
        duration > 0 && time !== null
          ? Math.max(0, Math.min(100, (time / duration) * 100))
          : 0;
      currentTimeRef.current = time;
      if (progressFillRef.current) {
        progressFillRef.current.style.width = `${pct}%`;
      }
      if (progressThumbRef.current) {
        progressThumbRef.current.style.left = `${pct}%`;
      }
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = `${time === null ? "--:--" : formatTime(time)} / ${durationLabelRef.current}`;
      }
    },
    [],
  );

  useEffect(() => {
    renderPlaybackTime(currentTimeRef.current);
  }, [displayDuration, durationLabel, renderPlaybackTime]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (autoNextTimerRef.current !== null) {
        clearInterval(autoNextTimerRef.current);
        autoNextTimerRef.current = null;
      }
      if (seekHoverFrameRef.current !== null) {
        cancelAnimationFrame(seekHoverFrameRef.current);
      }
      if (controlsFrameRef.current !== null) {
        cancelAnimationFrame(controlsFrameRef.current);
      }
    },
    [],
  );

  const resetTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setShowControls(true);
    hideTimerRef.current = setTimeout(() => {
      if (!selectorOpenRef.current) setShowControls(false);
    }, 3000);
  }, []);

  useEffect(() => {
    selectorOpenRef.current = openSelector !== null;
    if (openSelector) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setShowControls(true);
    }
  }, [openSelector]);

  useEffect(() => {
    if (!openSelector) return;
    const close = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".player-control-popover")
      ) {
        setOpenSelector(null);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openSelector]);

  useEffect(() => {
    if (
      (!playbackIds.mal && !playbackIds.anilist && !playbackIds.anikotoEpisode) ||
      isAnimeMovieFormat(format) ||
      episodeParts.length > 1
    ) {
      setLoadingEpisodeCount(false);
      return;
    }
    let cancelled = false;
    setLoadingEpisodeCount(true);
    fetchAnimeEpisodeCount(playbackIds)
      .then((count) => {
        if (!cancelled && count > 0) {
          setEpisodeCount((currentCount) =>
            mergeEpisodeCount(currentCount, count, episodeNumber),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEpisodeCount(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    episodeNumber,
    format,
    playbackIds.anilist,
    playbackIds.mal,
    playbackIds.anikotoEpisode,
    episodeParts.length,
  ]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.ended) {
        try {
          video.currentTime = 0;
        } catch {}
      }
      const requestId = ++playRequestRef.current;
      playIntentRef.current = true;
      hlsRef.current?.resumeBuffering();
      video.play().catch(() => {
        if (requestId !== playRequestRef.current) return;
        playIntentRef.current = false;
        hlsRef.current?.pauseBuffering();
        syncMediaState({ buffering: false, bufferingReason: null });
      });
    } else {
      playRequestRef.current += 1;
      playIntentRef.current = false;
      playAfterSeekRef.current = false;
      video.pause();
      hlsRef.current?.pauseBuffering();
    }
  }, [syncMediaState]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      const durationLimit =
        displayDuration ||
        (needsRestartSeek
          ? streamStartRef.current + cleanDuration(video.duration)
          : cleanDuration(video.duration));
      const target =
        durationLimit > 0
          ? Math.max(0, Math.min(durationLimit, seconds))
          : Math.max(0, seconds);
      pendingSeekRef.current = target;
      if (needsRestartSeek) {
        const shouldResume =
          !video.paused || playIntentRef.current || playAfterSeekRef.current;
        const localTarget = target - streamStartRef.current;
        if (localTarget >= 0 && hasBufferedTime(video, localTarget)) {
          try {
            video.currentTime = localTarget;
          } catch {}
          if (shouldResume) {
            playIntentRef.current = true;
            video.play().catch(() => {});
          }
          return;
        }
        playIntentRef.current = shouldResume;
        playAfterSeekRef.current = shouldResume;
        streamStartRef.current = target;
        syncMediaState({
          logicalOffset: target,
          error: null,
          buffering: true,
          bufferingReason: "seeking",
        });
        return;
      }
      try {
        video.currentTime = target;
      } catch {}
    },
    [displayDuration, needsRestartSeek, syncMediaState],
  );

  const handleSeek = useCallback(
    (event: MouseEvent) => {
      const video = videoRef.current;
      if (!video || !displayDuration) return;
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      seekTo(
        Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) *
          displayDuration,
      );
    },
    [displayDuration, seekTo],
  );

  const handleSeekKey = useCallback(
    (event: KeyboardEvent) => {
      if (!displayDuration) return;
      const current = mediaStateRef.current.currentTime ?? 0;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(current - 5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(current + 5);
      } else if (event.key === "Home") {
        event.preventDefault();
        seekTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        seekTo(displayDuration);
      }
    },
    [displayDuration, seekTo],
  );

  const updateSeekPreview = useCallback(() => {
    seekHoverFrameRef.current = null;
    const preview = seekPreviewRef.current;
    const rect = seekRectRef.current;
    if (!preview || !rect || !displayDuration) return;
    const pct = Math.max(
      0,
      Math.min(1, (seekHoverClientXRef.current - rect.left) / rect.width),
    );
    preview.style.left = `${pct * 100}%`;
    preview.textContent = formatTime(pct * displayDuration);
    preview.hidden = false;
  }, [displayDuration]);

  const measureSeekBar = useCallback(() => {
    seekRectRef.current = seekBarRef.current?.getBoundingClientRect() ?? null;
  }, []);

  const handleSeekHover = useCallback(
    (event: MouseEvent) => {
      if (!displayDuration) return;
      seekHoverClientXRef.current = event.clientX;
      if (!seekRectRef.current) measureSeekBar();
      if (seekHoverFrameRef.current === null) {
        seekHoverFrameRef.current = requestAnimationFrame(updateSeekPreview);
      }
    },
    [displayDuration, measureSeekBar, updateSeekPreview],
  );

  const clearSeekPreview = useCallback(() => {
    if (seekHoverFrameRef.current !== null) {
      cancelAnimationFrame(seekHoverFrameRef.current);
      seekHoverFrameRef.current = null;
    }
    seekRectRef.current = null;
    if (seekPreviewRef.current) seekPreviewRef.current.hidden = true;
  }, []);

  const handleVolume = useCallback((event: Event) => {
    const volume = Number((event.target as HTMLInputElement).value);
    const video = videoRef.current;
    if (!video || !Number.isFinite(volume)) return;
    video.volume = Math.max(0, Math.min(1, volume / 100));
    video.muted = false;
    localStorage.setItem("lyra-anime-volume", String(volume));
    syncMediaState();
  }, [syncMediaState]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    syncMediaState();
  }, [syncMediaState]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    document.fullscreenElement
      ? document.exitFullscreen().catch(() => {})
      : container.requestFullscreen().catch(() => {});
  }, []);

  const skipBack = useCallback(() => {
    const video = videoRef.current;
    if (video) seekTo(streamStartRef.current + video.currentTime - 10);
  }, [seekTo]);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (video) seekTo(streamStartRef.current + video.currentTime + 10);
  }, [seekTo]);

  const setSpeed = useCallback(
    (speed: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(speed)) return;
      video.playbackRate = speed;
      syncMediaState();
    },
    [syncMediaState],
  );

  const clearAutoNext = useCallback(() => {
    if (autoNextTimerRef.current !== null) {
      clearInterval(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    setAutoNext(null);
  }, []);

  useEffect(() => {
    const syncAnimeSettings = () => {
      const nextAutoPlay = readAnimeSetting("autoPlayNextEpisode");
      const nextAutoSkip = readAnimeSetting("autoSkipIntroOutro");
      setAutoPlayNextEpisode(nextAutoPlay);
      setAutoSkipIntroOutro(nextAutoSkip);
      if (!nextAutoPlay) clearAutoNext();
      if (!nextAutoSkip) autoSkippedMarkerRef.current = null;
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        event.key !== ANIME_SETTING_KEYS.autoPlayNextEpisode &&
        event.key !== ANIME_SETTING_KEYS.autoSkipIntroOutro
      ) {
        return;
      }
      syncAnimeSettings();
    };
    const onAnimeSettingUpdated = () => syncAnimeSettings();
    window.addEventListener("storage", onStorage);
    document.addEventListener("animeSettingUpdated", onAnimeSettingUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("animeSettingUpdated", onAnimeSettingUpdated);
    };
  }, [clearAutoNext]);

  const changeEpisode = useCallback(
    (nextEpisode: number, autoplay = false) => {
      if (
        nextEpisode === episodeNumber ||
        nextEpisode < 1 ||
        (episodeCount > 0 && nextEpisode > episodeCount)
      ) {
        setOpenSelector(null);
        return;
      }

      clearAutoNext();
      const video = videoRef.current;
      sourceContextGenerationRef.current += 1;
      const shouldKeepPlaying =
        autoplay ||
        Boolean(video && !video.paused && !video.ended) ||
        playIntentRef.current;
      const resumeTime = video
        ? streamStartRef.current + video.currentTime
        : currentTimeRef.current ?? 0;
      if (resumeTime > 0) {
        try {
          localStorage.setItem(
            resumeKey,
            JSON.stringify({ currentTime: resumeTime, timestamp: Date.now() }),
          );
        } catch {}
      }

      playIntentRef.current = shouldKeepPlaying;
      playAfterSeekRef.current = shouldKeepPlaying;
      if (video && !shouldKeepPlaying) video.pause();
      syncMediaState({
        sourceReady: false,
        buffering: true,
        bufferingReason: "waiting",
        error: null,
        durationHint: null,
        logicalOffset: 0,
      });
      setOpenSelector(null);
      setConfirmedEpisodeNumber(null);
      setEpisodeNumber(nextEpisode);
      setActiveAnikotoEpisodeId("");
      const nextPart = episodeParts.find(
        (part) => nextEpisode >= part.start && nextEpisode <= part.end,
      );
      setActivePartRange(nextPart || null);
      setActivePartIds(nextPart?.ids || identityIds);
      setEpisodeOffset(nextPart ? nextPart.start - 1 : 0);

      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("episode", String(nextEpisode));
      currentUrl.searchParams.set("episodeName", `E${nextEpisode}`);
      if (nextPart) {
        currentUrl.searchParams.set(
          "source_episode",
          String(nextEpisode - nextPart.start + 1),
        );
      } else {
        currentUrl.searchParams.delete("source_episode");
      }
      for (const key of ["anilist_id", "mal_id", "anikoto_episode_id"]) {
        currentUrl.searchParams.delete(key);
      }
      appendMegaPlayParams(currentUrl.searchParams, nextPart?.ids || identityIds);
      currentUrl.searchParams.delete("mochi_url");
      window.history.replaceState(null, "", currentUrl);
    }, [
      episodeCount,
      episodeNumber,
      resumeKey,
      episodeParts,
      identityIds,
      clearAutoNext,
      syncMediaState,
    ]);

  const startAutoNext = useCallback(() => {
    const nextEp = episodeNumber + 1;
    if (!autoPlayNextEpisode || episodeCount <= 0 || nextEp > episodeCount) {
      return;
    }

    clearAutoNext();
    let seconds = 10;
    setAutoNext({ episode: nextEp, seconds });
    autoNextTimerRef.current = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearAutoNext();
        changeEpisode(nextEp, true);
      } else {
        setAutoNext({ episode: nextEp, seconds });
      }
    }, 1000);
  }, [
    autoPlayNextEpisode,
    clearAutoNext,
    changeEpisode,
    episodeCount,
    episodeNumber,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;
    const hlsSession = ++hlsSessionRef.current;
    sessionStartedAtRef.current = performance.now();
    firstSegmentRecordedRef.current = false;
    firstFrameRecordedRef.current = false;
    rebufferStartedAtRef.current = null;
    rebufferCountRef.current = 0;
    totalRebufferDurationMsRef.current = 0;
    recordStreamDiagnostic("playback_start", {
      episode: episodeNumber,
      language,
    });
    manifestDurationRef.current = null;
    syncMediaState({
      error: null,
      buffering: true,
      sourceReady: false,
      bufferingReason: "waiting",
      durationHint: null,
      logicalOffset: streamStartRef.current,
    });
    setQualityOptions([]);
    setSelectedQuality(-1);
    setActiveQuality(-1);
    setAutoQuality(-1);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    if (playIntentRef.current) {
      playAfterSeekRef.current = true;
    }
    if (Hls.isSupported()) {
      let networkRecoveries = 0;
      let sourceRefreshes = 0;
      let mediaRecoveries = 0;
      let recoveryTimer: number | null = null;
      const hls = new Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 24 * 1024 * 1024,
        ...PLAYER_SIZE_ABR_CONFIG,
        manifestLoadPolicy: hlsLoadPolicy(8_000, 15_000, 2, 2),
        playlistLoadPolicy: hlsLoadPolicy(8_000, 15_000, 2, 2),
        fragLoadPolicy: hlsLoadPolicy(10_000, 45_000, 2, 3),
        keyLoadPolicy: hlsLoadPolicy(8_000, 20_000, 2, 2),
      });
      hlsRef.current = hls;
      const isCurrentHls = () =>
        hlsSession === hlsSessionRef.current && hlsRef.current === hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (isCurrentHls()) hls.loadSource(videoSrc);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, manifest) => {
        if (!isCurrentHls()) return;
        networkRecoveries = 0;
        syncMediaState({ sourceReady: true, error: null });
        const levels = manifest.levels
          .map((level, index) => {
            const width = Number(level.width || 0);
            const height = Number(level.height || 0);
            const bitrate = Number(level.bitrate || 0);
            return {
              index,
              width,
              height,
              bitrate,
              label: qualityLabel(height, bitrate),
            } satisfies StreamQualityOption;
          })
          .sort(
            (left, right) =>
              right.height - left.height || right.bitrate - left.bitrate,
          );
        setQualityOptions(levels);
        const preferredLevel = preferredQualityLevel(
          readAnimeQuality(),
          levels,
        );
        applyQualitySelection(
          hls,
          preferredLevel,
          levels.map((level) => level.index),
        );
        setSelectedQuality(preferredLevel);
        setActiveQuality(-1);
        if (preferredLevel < 0) {
          const nextAutoLevel = Number(hls.nextAutoLevel);
          setAutoQuality(
            levels.some((level) => level.index === nextAutoLevel)
              ? nextAutoLevel
              : -1,
          );
        } else {
          setAutoQuality(-1);
        }
        const nextAudioTracks = hls.audioTracks.map((track, index) => ({
          label: String(track.name || track.lang || `audio ${index + 1}`),
          language: String(track.lang || "und"),
          default: Boolean(track.default),
        }));
        setAudioTracks(nextAudioTracks);
        setActiveAudioTrack(
          Number.isInteger(hls.audioTrack) && hls.audioTrack >= 0
            ? hls.audioTrack
            : -1,
        );
        recordStreamDiagnostic("manifest_ready", {
          elapsedMs: Math.round(performance.now() - sessionStartedAtRef.current),
          levels: manifest.levels.length,
        });
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, levelInfo) => {
        if (!isCurrentHls()) return;
        const nextDuration = Number(levelInfo.details.totalduration || 0);
        if (
          levelInfo.details.live === false &&
          Number.isFinite(nextDuration) &&
          nextDuration > 0 &&
          manifestDurationRef.current === null
        ) {
          manifestDurationRef.current = nextDuration;
          syncMediaState({ durationHint: nextDuration, sourceReady: true });
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHING, (_event, levelInfo) => {
        if (!isCurrentHls() || !hls.autoLevelEnabled) return;
        const level = Number(levelInfo.level);
        setAutoQuality(Number.isInteger(level) && level >= 0 ? level : -1);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, levelInfo) => {
        if (!isCurrentHls()) return;
        const level = Number(levelInfo.level);
        setActiveQuality(Number.isInteger(level) && level >= 0 ? level : -1);
        syncMediaState({ sourceReady: true });
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, trackInfo) => {
        if (!isCurrentHls()) return;
        const track = Number(trackInfo.id);
        setActiveAudioTrack(
          Number.isInteger(track) && track >= 0 ? track : -1,
        );
        syncMediaState({ sourceReady: true });
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, fragmentInfo) => {
        if (!isCurrentHls()) return;
        networkRecoveries = 0;
        if (firstSegmentRecordedRef.current) return;
        firstSegmentRecordedRef.current = true;
        const stats = fragmentInfo.frag.stats;
        const loading = stats.loading;
        recordStreamDiagnostic("first_segment", {
          elapsedMs: Math.round(performance.now() - sessionStartedAtRef.current),
          bytes: stats.loaded,
          ttfbMs: Math.round(loading.first - loading.start),
          downloadMs: Math.round(loading.end - loading.first),
          retries: stats.retry,
        });
      });
      hls.on(Hls.Events.ERROR, (_event, hlsError) => {
        if (!isCurrentHls()) return;
        recordStreamDiagnostic("hls_error", {
          type: hlsError.type,
          detail: hlsError.details,
          status: hlsError.response?.code ?? null,
          fatal: hlsError.fatal,
        });
        if (!hlsError.fatal) return;
        if (hlsError.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (
            hlsError.response?.code === 409 &&
            sourceRefreshes < 1 &&
            recoveryTimer === null
          ) {
            sourceRefreshes += 1;
            recoveryTimer = window.setTimeout(() => {
              recoveryTimer = null;
              if (isCurrentHls()) hls.loadSource(videoSrc);
            }, 250);
            return;
          }
          if (networkRecoveries < 1 && recoveryTimer === null) {
            const delay = 500 * 2 ** networkRecoveries;
            networkRecoveries += 1;
            recoveryTimer = window.setTimeout(() => {
              recoveryTimer = null;
              if (isCurrentHls()) hls.startLoad(video.currentTime);
            }, delay);
            return;
          }
        }
        if (
          hlsError.type === Hls.ErrorTypes.MEDIA_ERROR &&
          mediaRecoveries < 1
        ) {
          mediaRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
        syncMediaState({
          error: negativeMessage("hls playback failed"),
          buffering: false,
        });
      });
      return () => {
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
        if (hlsSessionRef.current === hlsSession) hlsSessionRef.current += 1;
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
      };
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = videoSrc;
      video.load();
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }
    syncMediaState({
      error: negativeMessage("hls playback is not supported in this browser"),
      buffering: false,
    });
  }, [episodeNumber, language, videoSrc, syncMediaState]);

  useEffect(() => {
    if (
      episodeNumber < 1 ||
      episodeCount <= episodeNumber ||
      isAnimeMovieFormat(format)
    ) {
      return;
    }
    const nextVideoSrc = buildNextEpisodeStreamUrl(
      episodeNumber + 1,
      episodeParts,
      identityIds,
      language,
    );
    if (!nextVideoSrc) return;

    const preloadVideo = document.createElement("video");
    preloadVideo.preload = "auto";
    preloadVideo.crossOrigin = "anonymous";
    preloadVideo.muted = true;
    preloadVideo.playsInline = true;
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        backBufferLength: 0,
        maxBufferLength: 12,
        maxMaxBufferLength: 12,
      });
      hls.attachMedia(preloadVideo);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls?.loadSource(nextVideoSrc);
      });
    } else if (preloadVideo.canPlayType("application/vnd.apple.mpegurl")) {
      preloadVideo.src = nextVideoSrc;
      preloadVideo.load();
    }

    return () => {
      hls?.destroy();
      preloadVideo.pause();
      preloadVideo.removeAttribute("src");
      preloadVideo.load();
    };
  }, [
    episodeCount,
    episodeNumber,
    episodeParts,
    format,
    identityIds.anilist,
    identityIds.mal,
    language,
  ]);

  const refreshAutoQuality = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    const level = Number(hls.nextAutoLevel);
    setAutoQuality(
      qualityOptions.some((option) => option.index === level) ? level : -1,
    );
  }, [qualityOptions]);

  const chooseQuality = useCallback((index: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    if (
      !applyQualitySelection(
        hls,
        index,
        qualityOptions.map((option) => option.index),
      )
    ) return;
    setSelectedQuality(index);
    if (index < 0) refreshAutoQuality();
    setOpenSelector(null);
  }, [qualityOptions, refreshAutoQuality]);

  useEffect(() => {
    if (qualityOptions.length === 0) return;

    const applyPreference = () => {
      const hls = hlsRef.current;
      if (!hls) return;
      const level = preferredQualityLevel(readAnimeQuality(), qualityOptions);
      if (
        !applyQualitySelection(
          hls,
          level,
          qualityOptions.map((option) => option.index),
        )
      ) return;
      setSelectedQuality(level);
      if (level < 0) refreshAutoQuality();
      setOpenSelector(null);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ANIME_QUALITY_KEY) applyPreference();
    };
    const onAnimeSettingUpdated = (event: Event) => {
      if ((event as CustomEvent).detail?.key === ANIME_QUALITY_KEY) {
        applyPreference();
      }
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("animeSettingUpdated", onAnimeSettingUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener(
        "animeSettingUpdated",
        onAnimeSettingUpdated,
      );
    };
  }, [qualityOptions, refreshAutoQuality]);

  const chooseAudioTrack = useCallback(
    (index: number) => {
      const hls = hlsRef.current;
      if (
        !hls ||
        index < 0 ||
        index >= (hls.audioTracks || []).length ||
        !audioTracks[index]
      ) {
        return;
      }
      hls.audioTrack = index;
      setOpenSelector(null);
    },
    [audioTracks],
  );

  useEffect(() => {
    if (
      !(episodeNumber > 0 || playbackIds.anikotoEpisode) ||
      !hasMegaPlayIdentifier(playbackIds)
    ) {
      setLoadingStreamInfo(false);
      return;
    }
    const controller = new AbortController();
    const requestGeneration = ++sourceGenerationRef.current;
    setLoadingStreamInfo(true);
    const startedAt = performance.now();
    manifestDurationRef.current = null;
    setConfirmedLanguage(null);
    setIntroMarker(null);
    setOutroMarker(null);
    setSubtitleTracks([]);
    setSelectedSubtitle(-1);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    setNeedsTransmux(false);
    const params = new URLSearchParams({
      episode: String(sourceEpisodeNumber),
      language,
    });
    appendMegaPlayParams(params, playbackIds);

    fetchStreamInfo(params, controller.signal)
      .then((info) => {
        if (
          controller.signal.aborted ||
          requestGeneration !== sourceGenerationRef.current
        ) {
          return;
        }
        recordStreamDiagnostic("stream_info_ready", {
          elapsedMs: Math.round(performance.now() - startedAt),
          tracks: Array.isArray(info?.tracks) ? info.tracks.length : 0,
        });
        const nextDuration = Number(info?.duration || 0);
        setNeedsTransmux(Boolean(info?.needs_transmux));
        if (Number.isFinite(nextDuration) && nextDuration > 0) {
          manifestDurationRef.current = nextDuration;
          syncMediaState({ durationHint: nextDuration });
        }
        const sourceLanguage = info?.source?.language;
        setConfirmedLanguage(
          sourceLanguage === "sub" || sourceLanguage === "dub"
            ? sourceLanguage === language
              ? sourceLanguage
              : null
            : null,
        );
        setIntroMarker(info?.intro || null);
        setOutroMarker(info?.outro || null);
        const tracks = Array.isArray(info?.tracks) ? info.tracks : [];
        setSubtitleTracks(tracks);
        setAudioTracks(
          Array.isArray(info?.audio_tracks) ? info.audio_tracks : [],
        );
        setActiveAudioTrack(-1);
        const savedPreference = subtitlePreferenceRef.current;
        const savedTrack = tracks.findIndex(
          (track) => subtitlePreference(track) === savedPreference,
        );
        const englishTrack = tracks.findIndex(isEnglishSubtitle);
        const defaultTrack = tracks.findIndex((track) => track.default);
        const nextSubtitle =
          savedPreference === "off"
            ? -1
            : savedTrack >= 0
              ? savedTrack
              : englishTrack >= 0
                ? englishTrack
                : defaultTrack >= 0
                  ? defaultTrack
                  : tracks.length > 0
                    ? 0
                    : -1;
        if (nextSubtitle >= 0) {
          lastSubtitleRef.current = nextSubtitle;
          lastSubtitlePreferenceRef.current = subtitlePreference(
            tracks[nextSubtitle]!,
          );
        }
        setSelectedSubtitle(nextSubtitle);
      })
      .catch((err) => {
        if (
          controller.signal.aborted ||
          requestGeneration !== sourceGenerationRef.current
        ) {
          return;
        }
        setConfirmedLanguage(null);
        recordStreamDiagnostic("stream_info_error", {
          elapsedMs: Math.round(performance.now() - startedAt),
          code: err instanceof RequestError ? err.code : "STREAM_INFO_UNKNOWN",
          status: err instanceof RequestError ? err.status : undefined,
          message: negativeMessage("stream information request failed"),
        });
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          requestGeneration === sourceGenerationRef.current
        ) {
          setLoadingStreamInfo(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    sourceEpisodeNumber,
    playbackIds.anilist,
    playbackIds.mal,
    playbackIds.anikotoEpisode,
    language,
    syncMediaState,
  ]);

  const updateCaption = useCallback((track: TextTrack | null) => {
    const caption = captionRef.current;
    if (!caption) return;
    const activeCues = track?.activeCues;
    const cueText: string[] = [];
    if (activeCues) {
      for (let index = 0; index < activeCues.length; index++) {
        const text = cueTextToPlainText((activeCues[index] as VTTCue).text);
        if (text) cueText.push(text);
      }
    }
    caption.textContent = cueText.join("\n");
    caption.classList.toggle("is-visible", cueText.length > 0);
  }, []);

  const clearCaptionListener = useCallback(() => {
    if (captionTrackRef.current && captionChangeRef.current) {
      captionTrackRef.current.removeEventListener(
        "cuechange",
        captionChangeRef.current,
      );
    }
    captionTrackRef.current = null;
    captionChangeRef.current = null;
    updateCaption(null);
  }, [updateCaption]);

  const applySubtitleSelection = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    clearCaptionListener();
    const tracks = video.querySelectorAll<HTMLTrackElement>(
      'track[kind="subtitles"], track[kind="captions"]',
    );
    let nextActiveSubtitle = -1;
    tracks.forEach((track, index) => {
      const isSelected = index === selectedSubtitle;
      track.track.mode = isSelected ? "hidden" : "disabled";
      if (isSelected) {
        if (track.readyState === HTMLTrackElement.LOADED || track.track.cues) {
          nextActiveSubtitle = index;
        }
        const onCueChange = () => updateCaption(track.track);
        captionTrackRef.current = track.track;
        captionChangeRef.current = onCueChange;
        track.track.addEventListener("cuechange", onCueChange);
        updateCaption(track.track);
      }
    });
    setActiveSubtitle(nextActiveSubtitle);
  }, [clearCaptionListener, selectedSubtitle, updateCaption]);

  useEffect(() => {
    applySubtitleSelection();
    const frame = requestAnimationFrame(applySubtitleSelection);
    return () => {
      cancelAnimationFrame(frame);
      clearCaptionListener();
    };
  }, [
    applySubtitleSelection,
    clearCaptionListener,
    subtitleTracks,
    videoSrc,
  ]);

  const chooseSubtitle = useCallback(
    (index: number) => {
      if (index < -1 || index >= subtitleTracks.length) return;
      if (index >= 0 && subtitleTracks[index]) {
        const preference = subtitlePreference(subtitleTracks[index]);
        lastSubtitleRef.current = index;
        lastSubtitlePreferenceRef.current = preference;
        subtitlePreferenceRef.current = preference;
      } else {
        subtitlePreferenceRef.current = "off";
      }
      try {
        localStorage.setItem(
          SUBTITLE_PREFERENCE_KEY,
          subtitlePreferenceRef.current,
        );
      } catch {}
      setSelectedSubtitle(index);
      setOpenSelector(null);
    },
    [subtitleTracks],
  );

  const toggleCaptions = useCallback(() => {
    if (subtitleTracks.length === 0) return;
    setSelectedSubtitle((current) => {
      if (current >= 0) {
        lastSubtitleRef.current = current;
        if (subtitleTracks[current]) {
          lastSubtitlePreferenceRef.current = subtitlePreference(
            subtitleTracks[current],
          );
        }
        subtitlePreferenceRef.current = "off";
        try {
          localStorage.setItem(SUBTITLE_PREFERENCE_KEY, "off");
        } catch {}
        return -1;
      }
      const preferredIndex = subtitleTracks.findIndex(
        (track) =>
          subtitlePreference(track) === lastSubtitlePreferenceRef.current,
      );
      const nextIndex =
        preferredIndex >= 0
          ? preferredIndex
          : Math.min(lastSubtitleRef.current, subtitleTracks.length - 1);
      if (subtitleTracks[nextIndex]) {
        const preference = subtitlePreference(subtitleTracks[nextIndex]);
        subtitlePreferenceRef.current = preference;
        lastSubtitlePreferenceRef.current = preference;
        try {
          localStorage.setItem(SUBTITLE_PREFERENCE_KEY, preference);
        } catch {}
      }
      return nextIndex;
    });
  }, [subtitleTracks]);

  const changeLanguage = useCallback(
    async (nextLanguage: "sub" | "dub") => {
      setOpenSelector(null);
      if (
        nextLanguage === language ||
        changingLanguage ||
        !(episodeNumber > 0 || playbackIds.anikotoEpisode) ||
        !hasMegaPlayIdentifier(playbackIds)
      ) {
        return;
      }
      setChangingLanguage(true);
      const video = videoRef.current;
      const switchTime = video
        ? streamStartRef.current + video.currentTime
        : currentTimeRef.current ?? 0;
      const shouldKeepPlaying = Boolean(
        (video && !video.paused && !video.ended) || playIntentRef.current,
      );
      const params = new URLSearchParams({
        episode: String(sourceEpisodeNumber),
        language: nextLanguage,
      });
      appendMegaPlayParams(params, playbackIds);
      const requestContext = sourceContextRef.current;
      const requestGeneration = sourceContextGenerationRef.current;
      try {
        const info = await fetchStreamInfo(params);
        if (
          requestContext !== sourceContextRef.current ||
          requestGeneration !== sourceContextGenerationRef.current
        ) {
          return;
        }
        if (info.source?.language !== nextLanguage) {
          throw new Error(
            negativeMessage(`${nextLanguage} audio could not be confirmed`),
          );
        }
        sourceSwitchTimeRef.current = Math.max(0, switchTime);
        playIntentRef.current = shouldKeepPlaying;
        playAfterSeekRef.current = shouldKeepPlaying;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("language", nextLanguage);
        currentUrl.searchParams.delete("mochi_url");
        window.history.replaceState(null, "", currentUrl);
        setLanguage(nextLanguage);
      } catch (error) {
        if (
          requestContext !== sourceContextRef.current ||
          requestGeneration !== sourceContextGenerationRef.current
        ) {
          return;
        }
        recordStreamDiagnostic("audio_language_error", {
          language: nextLanguage,
          code: error instanceof RequestError ? error.code : "AUDIO_LANGUAGE_UNAVAILABLE",
          status: error instanceof RequestError ? error.status : undefined,
        });
        showToast("error", "language is unavailable for this episode", undefined, 4000);
      } finally {
        setChangingLanguage(false);
      }
    },
    [
      language,
      changingLanguage,
      sourceEpisodeNumber,
      playbackIds,
    ],
  );

  useEffect(() => {
    clearAutoNext();
    sourceContextGenerationRef.current += 1;
    const switchTime = sourceSwitchTimeRef.current;
    sourceSwitchTimeRef.current = null;
    pendingSeekRef.current = switchTime;
    resumeAppliedRef.current = false;
    retryCountRef.current = 0;
    playRequestRef.current += 1;
    streamStartRef.current = 0;
    playAfterSeekRef.current = playIntentRef.current;
    setNeedsTransmux(false);
    mediaHintsRef.current = {
      ...mediaHintsRef.current,
      logicalOffset: 0,
      sourceReady: false,
      buffering: Boolean(baseVideoSrc),
      bufferingReason: baseVideoSrc ? "waiting" : null,
      error: null,
      durationHint: null,
    };
    renderPlaybackTime(null);
    syncMediaState(mediaHintsRef.current);
  }, [baseVideoSrc, clearAutoNext, renderPlaybackTime, syncMediaState]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const mediaSession = ++mediaSessionRef.current;
    const isCurrentMedia = () =>
      mediaSession === mediaSessionRef.current && videoRef.current === video;

    const boundedTime = (seconds: number) => {
      const durationLimit =
        mediaStateRef.current.duration ||
        manifestDurationRef.current ||
        (needsRestartSeek
          ? streamStartRef.current + cleanDuration(video.duration)
          : cleanDuration(video.duration));
      return durationLimit > 0
        ? Math.max(0, Math.min(durationLimit, seconds))
        : Math.max(0, seconds);
    };
    const effectiveTime = () => streamStartRef.current + video.currentTime;
    const restorePendingSeek = () => {
      const pending = pendingSeekRef.current;
      if (pending === null || pending <= 0) return;
      const target = boundedTime(pending);
      if (needsRestartSeek) {
        const localTarget = target - streamStartRef.current;
        if (localTarget >= 0 && Math.abs(video.currentTime - localTarget) > 0.5) {
          try {
            video.currentTime = localTarget;
          } catch {}
        }
        renderPlaybackTime(effectiveTime());
        return;
      }
      if (Math.abs(video.currentTime - target) > 0.5) {
        try {
          video.currentTime = target;
        } catch {}
        renderPlaybackTime(effectiveTime());
      }
    };
    const clearSettledPendingSeek = () => {
      const pending = pendingSeekRef.current;
      if (pending !== null && Math.abs(effectiveTime() - pending) < 1.5) {
        pendingSeekRef.current = null;
      }
    };
    const resumePlaybackIfWanted = () => {
      if (!playIntentRef.current && !playAfterSeekRef.current) return;
      hlsRef.current?.resumeBuffering();
      const requestId = ++playRequestRef.current;
      video
        .play()
        .then(() => {
          if (requestId !== playRequestRef.current || !isCurrentMedia()) return;
          playAfterSeekRef.current = false;
        })
        .catch((error) => {
          if (requestId !== playRequestRef.current || !isCurrentMedia()) return;
          playIntentRef.current = false;
          playAfterSeekRef.current = false;
          hlsRef.current?.pauseBuffering();
          recordStreamDiagnostic(
            error instanceof DOMException && error.name === "NotAllowedError"
              ? "autoplay_blocked"
              : "playback_rejected",
          );
        });
    };

    const syncPlaybackState = () => {
      if (isCurrentMedia()) syncMediaState();
    };
    const finishRebuffer = () => {
      if (rebufferStartedAtRef.current === null) return;
      const durationMs = Math.round(
        performance.now() - rebufferStartedAtRef.current,
      );
      totalRebufferDurationMsRef.current += durationMs;
      recordStreamDiagnostic("buffering_end", {
        durationMs,
        rebufferCount: rebufferCountRef.current,
        totalRebufferDurationMs: totalRebufferDurationMsRef.current,
      });
      rebufferStartedAtRef.current = null;
    };

    const handlePlay = () => {
      if (!isCurrentMedia()) return;
      playIntentRef.current = true;
      syncPlaybackState();
    };
    const handlePlaying = () => {
      if (!isCurrentMedia()) return;
      playIntentRef.current = true;
      syncPlaybackState();
      syncMediaState({
        sourceReady: true,
        buffering: false,
        bufferingReason: null,
        error: null,
      });
      if (!firstFrameRecordedRef.current) {
        firstFrameRecordedRef.current = true;
        recordStreamDiagnostic("first_playable_frame", {
          elapsedMs: Math.round(
            performance.now() - sessionStartedAtRef.current,
          ),
        });
      }
      finishRebuffer();
    };
    const handlePause = () => {
      if (!isCurrentMedia()) return;
      syncPlaybackState();
      syncMediaState({ buffering: false, bufferingReason: null });
      finishRebuffer();
      if (!playIntentRef.current) hlsRef.current?.pauseBuffering();
    };
    const handleEnded = () => {
      if (!isCurrentMedia()) return;
      playIntentRef.current = false;
      playAfterSeekRef.current = false;
      renderPlaybackTime(effectiveTime());
      syncMediaState({
        sourceReady: true,
        buffering: false,
        bufferingReason: null,
      });
      finishRebuffer();
      if (autoNextTimerRef.current === null) startAutoNext();
    };
    const handleTimeUpdate = () => {
      if (!isCurrentMedia()) return;
      renderPlaybackTime(effectiveTime());
      clearSettledPendingSeek();
      syncMediaState(
        !video.paused && !video.seeking
          ? { buffering: false, bufferingReason: null }
          : {},
      );
    };
    const handleMetadata = () => {
      if (!isCurrentMedia()) return;
      setConfirmedEpisodeNumber(episodeNumber > 0 ? episodeNumber : null);
      syncMediaState({ sourceReady: true });
    };
    const handleDurationChange = () => {
      if (isCurrentMedia()) syncMediaState();
    };
    const handleBuffering = (reason: "waiting" | "stalled") => {
      if (!isCurrentMedia()) return;
      syncMediaState({ buffering: true, bufferingReason: reason });
      if (
        firstFrameRecordedRef.current &&
        rebufferStartedAtRef.current === null
      ) {
        rebufferStartedAtRef.current = performance.now();
        rebufferCountRef.current += 1;
        recordStreamDiagnostic("buffering_start", {
          playbackTime: Math.round(effectiveTime() * 1000) / 1000,
          reason,
          rebufferCount: rebufferCountRef.current,
        });
      }
    };
    const handleWaiting = () => handleBuffering("waiting");
    const handleStalled = () => handleBuffering("stalled");
    const handlePlayable = () => {
      if (!isCurrentMedia()) return;
      const hasFutureData =
        !video.paused &&
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      syncMediaState({
        sourceReady: true,
        ...(hasFutureData
          ? { buffering: false, bufferingReason: null }
          : {}),
      });
      restorePendingSeek();
      resumePlaybackIfWanted();
      syncPlaybackState();
    };
    const handleError = () => {
      if (!isCurrentMedia()) return;
      const mediaError = video.error;
      const code = mediaError ? mediaError.code : 0;
      recordStreamDiagnostic("media_error", { code });
      syncMediaState({
        error: negativeMessage(`media playback failed (code ${code})`),
        buffering: false,
        bufferingReason: null,
      });
      if (
        (code === 2 || code === 3 || code === 4) &&
        !Hls.isSupported() &&
        retryCountRef.current < 1 &&
        videoSrc
      ) {
        const retryTime = boundedTime(
          pendingSeekRef.current ?? effectiveTime(),
        );
        if (retryTime > 0) pendingSeekRef.current = retryTime;
        retryCountRef.current++;
        nativeRetryTimerRef.current = setTimeout(() => {
          nativeRetryTimerRef.current = null;
          if (!isCurrentMedia()) return;
          syncMediaState({ error: null, buffering: true });
          if (video) {
            video.load();
            if (playIntentRef.current || playAfterSeekRef.current) {
              video.play().catch(() => {});
            }
          }
        }, 2000);
      }
    };

    const handleProgress = () => {
      if (isCurrentMedia()) syncMediaState();
    };
    const handleVolumeChange = () => {
      if (isCurrentMedia()) syncMediaState();
    };
    const restoreResumePosition = () => {
      if (!isCurrentMedia()) return;
      if (pendingSeekRef.current !== null) {
        restorePendingSeek();
        return;
      }
      if (resumeAppliedRef.current) return;
      resumeAppliedRef.current = true;
      const savedResume = localStorage.getItem(resumeKey);
      if (savedResume) {
        try {
          const resumeState = JSON.parse(savedResume);
          const savedTime = Number(resumeState?.currentTime);
          const durationLimit =
            mediaStateRef.current.duration ||
            manifestDurationRef.current ||
            cleanDuration(video.duration) ||
            Infinity;
          if (
            Number.isFinite(savedTime) &&
            savedTime > 0 &&
            savedTime < durationLimit * 0.9
          ) {
            if (needsRestartSeek) {
              pendingSeekRef.current = savedTime;
              streamStartRef.current = savedTime;
              mediaHintsRef.current.logicalOffset = savedTime;
              syncMediaState({ logicalOffset: savedTime, buffering: true });
              return;
            }
            try {
              video.currentTime = savedTime;
            } catch {}
          }
        } catch {}
      }
    };

    const events: [string, EventListener][] = [
      ["play", handlePlay],
      ["playing", handlePlaying],
      ["pause", handlePause],
      ["ended", handleEnded],
      ["timeupdate", handleTimeUpdate],
      ["loadedmetadata", handleMetadata],
      ["loadedmetadata", restoreResumePosition],
      ["durationchange", handleDurationChange],
      ["waiting", handleWaiting],
      ["loadeddata", handlePlayable],
      ["canplay", handlePlayable],
      ["canplaythrough", handlePlayable],
      ["error", handleError],
      ["stalled", handleStalled],
      ["progress", handleProgress],
      ["volumechange", handleVolumeChange],
      ["seeking", () => {
        if (!isCurrentMedia()) return;
        renderPlaybackTime(effectiveTime());
        syncPlaybackState();
      }],
      ["seeked", () => {
        if (!isCurrentMedia()) return;
        clearSettledPendingSeek();
        updateCaption(captionTrackRef.current);
        const needsBuffering =
          !video.paused &&
          !video.ended &&
          video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
        syncMediaState({
          buffering: needsBuffering,
          bufferingReason: needsBuffering ? "seeking" : null,
        });
      }],
      ["ratechange", syncPlaybackState],
      ["resize", syncPlaybackState],
    ];
    for (const [eventName, listener] of events) {
      video.addEventListener(eventName, listener);
    }
    const syncOnVisibility = () => syncPlaybackState();
    document.addEventListener("visibilitychange", syncOnVisibility);
    window.addEventListener("focus", syncOnVisibility);

    syncPlaybackState();

    return () => {
      if (mediaSessionRef.current === mediaSession) mediaSessionRef.current += 1;
      finishRebuffer();
      recordStreamDiagnostic("playback_qoe", {
        rebufferCount: rebufferCountRef.current,
        totalRebufferDurationMs: totalRebufferDurationMsRef.current,
      });
      const currentTime = effectiveTime();
      if (currentTime > 0) {
        try {
          localStorage.setItem(
            resumeKey,
            JSON.stringify({ currentTime, timestamp: Date.now() }),
          );
        } catch {}
      }
      for (const [eventName, listener] of events) {
        video.removeEventListener(eventName, listener);
      }
      document.removeEventListener("visibilitychange", syncOnVisibility);
      window.removeEventListener("focus", syncOnVisibility);
      if (nativeRetryTimerRef.current) {
        clearTimeout(nativeRetryTimerRef.current);
        nativeRetryTimerRef.current = null;
      }
    };
  }, [
    episodeNumber,
    resumeKey,
    startAutoNext,
    videoSrc,
    needsRestartSeek,
    renderPlaybackTime,
    syncMediaState,
    updateCaption,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume / 100;
      video.muted = muted;
      video.playbackRate = rate;
      syncMediaState();
    }
  }, [muted, rate, syncMediaState, volume]);
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const video = videoRef.current;
      if (!video) return;
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        /^[0-9]$/.test(event.key)
      ) {
        if (!displayDuration) return;
        event.preventDefault();
        seekTo(displayDuration * (Number(event.key) / 10));
        return;
      }
      switch (event.key) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "k":
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekTo(streamStartRef.current + video.currentTime - 5);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekTo(streamStartRef.current + video.currentTime + 5);
          break;
        case "j":
          seekTo(streamStartRef.current + video.currentTime - 10);
          break;
        case "l":
          seekTo(streamStartRef.current + video.currentTime + 10);
          break;
        case "ArrowUp":
          event.preventDefault();
          video.volume = Math.min(1, (volume + 5) / 100);
          video.muted = false;
          localStorage.setItem("lyra-anime-volume", String(Math.min(100, volume + 5)));
          syncMediaState();
          break;
        case "ArrowDown":
          event.preventDefault();
          video.volume = Math.max(0, (volume - 5) / 100);
          video.muted = false;
          localStorage.setItem("lyra-anime-volume", String(Math.max(0, volume - 5)));
          syncMediaState();
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "c":
        case "C":
          event.preventDefault();
          toggleCaptions();
          break;
        case ">":
          setSpeed(Math.min(2, rate + 0.25));
          break;
        case "<":
          setSpeed(Math.max(0.5, rate - 0.25));
          break;
        case "?":
          setShowKeys(!showKeys);
          break;
      }
    };
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [
    togglePlay,
    toggleMute,
    toggleFullscreen,
    toggleCaptions,
    displayDuration,
    seekTo,
    syncMediaState,
    volume,
    rate,
    showKeys,
  ]);

  useEffect(() => {
    const updateFullscreenState = () =>
      setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () =>
      document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleMouseMove = () => {
      if (controlsFrameRef.current !== null) return;
      controlsFrameRef.current = requestAnimationFrame(() => {
        controlsFrameRef.current = null;
        resetTimer();
      });
    };
    const handleMouseLeave = () => {
      if (controlsFrameRef.current !== null) {
        cancelAnimationFrame(controlsFrameRef.current);
        controlsFrameRef.current = null;
      }
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (!selectorOpenRef.current) setShowControls(false);
    };
    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("mouseleave", handleMouseLeave);
    resetTimer();
    return () => {
      container.removeEventListener("mousemove", handleMouseMove);
      container.removeEventListener("mouseleave", handleMouseLeave);
      if (controlsFrameRef.current !== null) {
        cancelAnimationFrame(controlsFrameRef.current);
        controlsFrameRef.current = null;
      }
    };
  }, [resetTimer]);

  useEffect(() => {
    const status = resolvePlayerStatus(
      mediaState.status,
      Boolean(videoSrc),
      loadingEpisodeCount || loadingStreamInfo || changingLanguage,
    );
    reportPlayerStatus(status);
  }, [
    changingLanguage,
    loadingEpisodeCount,
    loadingStreamInfo,
    mediaState.status,
    reportPlayerStatus,
    videoSrc,
  ]);

  useEffect(
    () => () => {
      reportPlayerStatus("idle");
    },
    [reportPlayerStatus],
  );

  useEffect(() => {
    if (title) {
      document.title = title;
    }
    if (poster) {
      let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "shortcut icon";
        document.head.appendChild(link);
      }
      link.href = poster;
    }

    const parentLyra = (window.parent as any)?.Lyra;
    if (parentLyra?.tabs) {
      const myTab = parentLyra.tabs.find(
        (t: any) => t.iframe?.contentWindow === window,
      );
      if (myTab) {
        if (title) myTab.title = title;
        if (poster) myTab.favicon = poster;
        parentLyra.renderTabs?.();
      }
    }
  }, [title, poster]);

  const bufferedRanges = mediaState.buffered;
  const playControlActive = !mediaState.paused && !mediaState.ended;
  const requestedQuality =
    selectedQuality >= 0
      ? qualityOptions.find((option) => option.index === selectedQuality)
      : null;
  const autoQualityOption =
    autoQuality >= 0
      ? qualityOptions.find((option) => option.index === autoQuality)
      : null;
  const autoQualityName = autoQualityOption
    ? qualityName(autoQualityOption.label)
    : null;
  const selectedQualityLabel = qualityMenuLabel(
    selectedQuality >= 0 ? qualityName(requestedQuality?.label) : null,
    autoQualityName,
    selectedQuality >= 0 && selectedQuality !== activeQuality,
  );
  const activeAudioLabel =
    activeAudioTrack >= 0
      ? audioTracks[activeAudioTrack]?.label || "unknown"
      : audioTracks.length > 0
        ? "unknown"
        : negativeMessage("unavailable");
  const currentPlaybackTime = mediaState.currentTime;
  const activeSkip =
    !mediaState.seeking && currentPlaybackTime !== null
      ? introMarker &&
        currentPlaybackTime >= introMarker.start &&
        currentPlaybackTime < introMarker.end
        ? { label: "skip intro", end: introMarker.end }
        : outroMarker &&
            currentPlaybackTime >= outroMarker.start &&
            currentPlaybackTime < outroMarker.end
          ? { label: "skip outro", end: outroMarker.end }
          : null
      : null;
  const activeSkipKey = activeSkip
    ? `${activeSkip.label}:${activeSkip.end}`
    : null;
  const activeSkipEnd = activeSkip?.end ?? null;

  useEffect(() => {
    if (!autoSkipIntroOutro || !activeSkipKey || activeSkipEnd === null) {
      if (!autoSkipIntroOutro || !activeSkipKey) {
        autoSkippedMarkerRef.current = null;
      }
      return;
    }
    if (autoSkippedMarkerRef.current === activeSkipKey) return;
    autoSkippedMarkerRef.current = activeSkipKey;
    seekTo(activeSkipEnd);
  }, [activeSkipEnd, activeSkipKey, autoSkipIntroOutro, seekTo]);

  const episodeButtons = useMemo(
    () =>
      Array.from({ length: Math.max(episodeCount, episodeNumber) }, (_, index) => {
        const value = index + 1;
        const isCurrent = value === confirmedEpisodeNumber;
        return (
          <button
            type="button"
            role="option"
            key={value}
            aria-selected={isCurrent}
            tabIndex={openSelector === "episodes" ? 0 : -1}
            class={`episode-selector-button player-episode-item${
              isCurrent ? " is-active" : ""
            }`}
            onClick={() => changeEpisode(value)}
          >
            {value}
          </button>
        );
      }),
    [changeEpisode, confirmedEpisodeNumber, episodeCount, openSelector],
  );
  return (
    <div class="player-page is-visible">
      <div
        class={`video-container${showControls ? "" : " hide-cursor"}`}
        data-player-status={mediaState.status}
        data-buffering-reason={mediaState.bufferingReason || undefined}
        data-seeking={mediaState.seeking ? "true" : "false"}
        aria-busy={mediaState.status === "loading" || mediaState.buffering}
        ref={containerRef}
      >
        <video
          ref={videoRef}
          autoPlay
          preload="metadata"
          crossOrigin="anonymous"
          onClick={togglePlay}
        >
          {subtitleTracks.map((track) => (
            <track
              key={track.src}
              kind={track.kind === "captions" ? "captions" : "subtitles"}
              src={track.src}
              label={track.label}
              srclang={track.language || "und"}
              onLoad={applySubtitleSelection}
            />
          ))}
        </video>
        <div
          ref={captionRef}
          class="player-captions"
          aria-hidden="true"
        />

        {loadError && (
          <div class="video-loading is-error">
            <span class="loading-status">{negativeMessage("stream load failed")}</span>
            <span class="loading-speed">{loadError}</span>
          </div>
        )}

        {(loading || buffering) && !loadError && (
          <div
            class="video-loading"
            role="status"
          />
        )}
        {activeSkip && (
          <button
            type="button"
            class="player-skip-marker"
            onClick={() => seekTo(activeSkip.end)}
          >
            {activeSkip.label}
          </button>
        )}
        {autoNext && (
          <div class="player-next-episode-card" role="status" aria-live="polite">
            <div class="player-next-episode-copy">
              <span>up next</span>
              <strong>episode {autoNext.episode}</strong>
              <small>playing in {autoNext.seconds}s</small>
            </div>
            <div class="player-next-episode-actions">
              <button
                type="button"
                class="player-action-button player-action-button-secondary"
                onClick={clearAutoNext}
              >
                cancel
              </button>
              <button
                type="button"
                class="player-action-button"
                onClick={() => {
                  const nextEpisode = autoNext.episode;
                  clearAutoNext();
                  changeEpisode(nextEpisode, true);
                }}
              >
                play now
              </button>
            </div>
          </div>
        )}

        <div class={`player-controls${showControls ? "" : " is-hidden"}`}>
          <div
            ref={seekBarRef}
            class="seek-bar"
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={displayDuration || undefined}
            aria-valuenow={mediaState.currentTime ?? undefined}
            aria-valuetext={`${mediaState.currentTime === null ? "--:--" : formatTime(mediaState.currentTime)} / ${durationLabel}`}
            onClick={handleSeek}
            onKeyDown={handleSeekKey}
            onMouseEnter={measureSeekBar}
            onMouseMove={handleSeekHover}
            onMouseLeave={clearSeekPreview}
          >
            <div ref={seekPreviewRef} class="seek-preview" hidden />
            {bufferedRanges.map((range, index) => {
              if (!displayDuration) return null;
              const left = Math.max(0, Math.min(100, (range.start / displayDuration) * 100));
              const right = Math.max(0, Math.min(100, (range.end / displayDuration) * 100));
              return (
                <div
                  class="seek-bar-buffered"
                  key={`${range.start}-${range.end}-${index}`}
                  style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
                />
              );
            })}
            <div ref={progressFillRef} class="seek-bar-fill" />
            <div ref={progressThumbRef} class="seek-bar-thumb" />
          </div>

          <div class="controls-row">
            <button
              class="player-btn player-btn-play"
              onClick={togglePlay}
            >
              {playControlActive ? (
                <IconPause size={24} />
              ) : (
                <IconPlay size={24} />
              )}
            </button>
            <button
              class="player-btn"
              onClick={skipBack}
            >
              <IconBack10s size={24} />
            </button>
            <button
              class="player-btn"
              onClick={skipForward}
            >
              <IconForwards10s size={24} />
            </button>
            <div class="volume-wrapper">
              <button
                class="player-btn"
                onClick={toggleMute}
              >
                {muted || volume === 0 ? (
                  <IconVolumeOff size={24} />
                ) : volume <= 33 ? (
                  <IconVolumeMinimum size={24} />
                ) : volume <= 66 ? (
                  <IconVolumeHalf size={24} />
                ) : (
                  <IconVolumeFull size={24} />
                )}
              </button>
              <input
                type="range"
                class="volume-slider"
                min="0"
                max="100"
                value={muted ? 0 : volume}
                onInput={handleVolume}
                style={{ "--vol-pct": `${muted ? 0 : volume}%` } as any}
              />
            </div>
            <div ref={timeDisplayRef} class="time-display">
              --:-- / {durationLabel}
            </div>
            <div class="spacer" />
            {!isAnimeMovieFormat(format) && (
              <div class="player-control-popover player-episode-control">
              <button
                type="button"
                class={`player-selector-selected player-episode-trigger${openSelector === "episodes" ? " is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={openSelector === "episodes"}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenSelector((current) =>
                    current === "episodes" ? null : "episodes",
                  );
                }}
              >
                <span>ep {confirmedEpisodeNumber ?? "?"}</span>
                <IconChevronBottom size={12} class="selector-chevron" />
              </button>
              <div
                class={`player-selector-options player-episode-panel${openSelector === "episodes" ? " is-open" : ""}`}
                role="listbox"
                aria-hidden={openSelector !== "episodes"}
              >
                <div class="player-episode-heading">
                  <div>
                    <strong>{title}</strong>
                    <span>choose an episode</span>
                  </div>
                  <span class="player-episode-position">
                    {confirmedEpisodeNumber ?? "?"} / {episodeCount > 0 ? Math.max(episodeCount, episodeNumber) : "?"}
                  </span>
                </div>
                <div class="episode-selector-grid player-episode-grid">
                  {episodeButtons}
                </div>
              </div>
              </div>
            )}
            <div class="player-control-popover player-language-selector">
              <button
                type="button"
                class={`player-selector-selected${openSelector === "language" ? " is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={openSelector === "language"}
                disabled={changingLanguage}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenSelector((current) =>
                    current === "language" ? null : "language",
                  );
                }}
              >
                <span title={`confirmed audio: ${activeAudioLabel}`}>
                  {changingLanguage ? "..." : confirmedLanguage || "unknown"}
                </span>
                <IconChevronBottom size={12} class="selector-chevron" />
              </button>
              <div
                class={`player-selector-options${openSelector === "language" ? " is-open" : ""}`}
                role="listbox"
                aria-hidden={openSelector !== "language"}
              >
                {(["sub", "dub"] as const)
                  .filter((option) => option !== language)
                  .map((option) => (
                    <button
                      type="button"
                      role="option"
                      tabIndex={openSelector === "language" ? 0 : -1}
                      key={option}
                      onClick={() => void changeLanguage(option)}
                    >
                      {option}
                    </button>
                  ))}
              </div>
            </div>
            {audioTracks.length > 1 &&
              (hlsRef.current?.audioTracks || []).length > 1 && (
              <div class="player-control-popover player-audio-selector">
                <button
                  type="button"
                  class={`player-selector-selected${openSelector === "audio" ? " is-open" : ""}`}
                  aria-haspopup="listbox"
                  aria-expanded={openSelector === "audio"}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenSelector((current) =>
                      current === "audio" ? null : "audio",
                    );
                  }}
                >
                  <span>{activeAudioTrack >= 0 ? activeAudioLabel : "audio ?"}</span>
                  <IconChevronBottom size={12} class="selector-chevron" />
                </button>
                <div
                  class={`player-selector-options${openSelector === "audio" ? " is-open" : ""}`}
                  role="listbox"
                  aria-hidden={openSelector !== "audio"}
                >
                  {audioTracks.map((track, index) => (
                    <button
                      type="button"
                      role="option"
                      tabIndex={openSelector === "audio" ? 0 : -1}
                      aria-selected={activeAudioTrack === index}
                      class={activeAudioTrack === index ? "is-active" : ""}
                      key={`${track.language}-${track.label}-${index}`}
                      onClick={() => chooseAudioTrack(index)}
                    >
                      <span>{track.label}</span>
                      {activeAudioTrack === index && (
                        <IconCheckCircle2 size={12} class="player-option-check" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div class="player-control-popover player-subtitle-control">
              <button
                type="button"
                class={`player-btn player-btn-cc${activeSubtitle >= 0 ? " is-active" : ""}${activeSubtitle < 0 ? " is-off" : ""}${openSelector === "subtitles" ? " is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={openSelector === "subtitles"}
                disabled={subtitleTracks.length === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenSelector((current) =>
                    current === "subtitles" ? null : "subtitles",
                  );
                }}
              >
                <IconBubbleText size={24} />
              </button>
              <div
                class={`player-selector-options player-subtitle-options${openSelector === "subtitles" ? " is-open" : ""}`}
                role="listbox"
                aria-hidden={openSelector !== "subtitles"}
              >
                <button
                  type="button"
                  role="option"
                  tabIndex={openSelector === "subtitles" ? 0 : -1}
                  aria-selected={activeSubtitle < 0}
                  class={activeSubtitle < 0 ? "is-active" : ""}
                  onClick={() => chooseSubtitle(-1)}
                >
                  <span>off</span>
                  {activeSubtitle < 0 && (
                    <IconCheckCircle2
                      size={12}
                      solid
                      class="player-option-check"
                    />
                  )}
                </button>
                {subtitleTracks.map((track, index) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={openSelector === "subtitles" ? 0 : -1}
                    aria-selected={activeSubtitle === index}
                    class={activeSubtitle === index ? "is-active" : ""}
                    key={track.src}
                    onClick={() => chooseSubtitle(index)}
                  >
                    <span>{track.label.toLowerCase()}</span>
                    {activeSubtitle === index && (
                      <IconCheckCircle2
                        size={12}
                        solid
                        class="player-option-check"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
            {qualityOptions.length > 1 && (
              <div class="player-control-popover player-quality-selector">
                <button
                  type="button"
                  class={`player-selector-selected${openSelector === "quality" ? " is-open" : ""}`}
                  aria-haspopup="listbox"
                  aria-expanded={openSelector === "quality"}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (openSelector !== "quality") refreshAutoQuality();
                    setOpenSelector((current) =>
                      current === "quality" ? null : "quality",
                    );
                  }}
                >
                  <span>{selectedQualityLabel}</span>
                  <IconChevronBottom size={12} class="selector-chevron" />
                </button>
                <div
                  class={`player-selector-options player-quality-options${openSelector === "quality" ? " is-open" : ""}`}
                  role="listbox"
                  aria-hidden={openSelector !== "quality"}
                >
                  <button
                    type="button"
                    role="option"
                    tabIndex={openSelector === "quality" ? 0 : -1}
                    aria-selected={selectedQuality < 0}
                    class={selectedQuality < 0 ? "is-active" : ""}
                    onClick={() => chooseQuality(-1)}
                  >
                    <span>{qualityMenuLabel(null, autoQualityName)}</span>
                    {selectedQuality < 0 && (
                      <IconCheckCircle2
                        size={12}
                        solid
                        class="player-option-check"
                      />
                    )}
                  </button>
                  {[...qualityOptions]
                    .sort((left, right) => right.height - left.height || right.bitrate - left.bitrate)
                    .map((option) => (
                      <button
                        type="button"
                        role="option"
                        tabIndex={openSelector === "quality" ? 0 : -1}
                        aria-selected={selectedQuality === option.index}
                        class={selectedQuality === option.index ? "is-active" : ""}
                        key={`${option.index}-${option.label}`}
                        onClick={() => chooseQuality(option.index)}
                      >
                        <span>{option.label}</span>
                        {selectedQuality === option.index && (
                          <IconCheckCircle2
                            size={12}
                            solid
                            class="player-option-check"
                          />
                        )}
                      </button>
                    ))}
                </div>
              </div>
            )}
            <button
              class="player-btn"
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <IconDownsize size={24} />
              ) : (
                <IconFullScreen size={24} />
              )}
            </button>
          </div>
        </div>

        {showKeys && (
          <div class="shortcuts-overlay" onClick={() => setShowKeys(false)}>
            <div
              class="shortcuts-card"
              onClick={(event) => event.stopPropagation()}
            >
              <h3>keyboard shortcuts</h3>
              <div class="shortcuts-grid">
                <kbd>space / k</kbd>
                <span>play / pause</span>
                <kbd>← →</kbd>
                <span>seek 5s</span>
                <kbd>j l</kbd>
                <span>seek 10s</span>
                <kbd>0–9</kbd>
                <span>seek to 0–90%</span>
                <kbd>↑ ↓</kbd>
                <span>volume</span>
                <kbd>m</kbd>
                <span>mute</span>
                <kbd>f</kbd>
                <span>fullscreen</span>
                <kbd>c</kbd>
                <span>captions</span>
                <kbd>?</kbd>
                <span>toggle this</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
