import { store, showLoading, hideLoading } from "../../state/store.ts";
import {
  decodeUrl,
  getProxyUrl,
  normalizeGameHistoryUrl,
} from "../runtime/utils";
import { currentUrlSignal } from "../ui/uiSignals";
import {
  getLoadedGameCover,
  getLoadedGameDisplayLabel,
} from "../media/gameMetadata.ts";
import { getAnimeDisplayLabel } from "../media/animeMetadata.ts";
import { getStoredGameSource, type GameSourceKey } from "../config/settingsOptions.ts";
import { ensureProxyRuntime } from "../proxy/proxyRuntime.ts";
import { getRivet } from "../proxy/rivetBridge.ts";
import { hostFromUrl, recordGameMetric } from "../media/gameDiagnostics.ts";
import { NEGATIVE } from "../runtime/messages.ts";
import type { HistoryManager } from "./history.ts";

interface LyraTab {
  id: number;
  iframe: HTMLIFrameElement;
  title: string;
  favicon: string | null;
  isUrlLoaded: boolean;
  isLoading: boolean;
  isGame?: boolean;
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  gameDisplayByUrl?: Record<string, string>;
  extensionPage?: {
    extId: string;
    page: string;
    url: string;
  };
  pageState?: {
    url: string | null;
    title: string;
    favicon: string | null;
    historyLength: number | null;
    historyState: unknown;
    navigationType: string | null;
    updatedAt: number;
  };
  historyManager?: HistoryManager;
  [key: string]: unknown;
}

interface HistoryUIState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface UrlTrackedTab {
  extensionPage?: { url: string };
  pageState?: { url: string | null };
  historyManager?: { getCurrentUrl(): string | null };
}

type IframeHistoryManager = NonNullable<LyraTab["historyManager"]>;
type IframeInternalHandlers = {
  onError: EventListener;
  onLoad: EventListener;
  version: number;
};

declare global {
  interface Window {
    Lyra: {
      tabs?: LyraTab[];
      isLoading?: boolean;
      setPlayerStatus?: (tabId: number, status: string) => void;
      navigateFolio?: (
        iframe: HTMLIFrameElement,
        url: string,
      ) => Promise<void>;
      releaseFolioFrame?: (iframe: HTMLIFrameElement) => void;
      waitForTransport?: (timeout: number) => Promise<void>;
      [key: string]: unknown;
    };
  }
}

const GAME_LOAD_TIMEOUT_MS = 45_000;
const navigationVersions = new WeakMap<HTMLIFrameElement, number>();

function syncGlobalLoadingState(): void {
  window.Lyra.isLoading = Boolean(
    window.Lyra.tabs?.some((tab: LyraTab) => tab.isLoading),
  );
}

function beginNavigation(iframe: HTMLIFrameElement): number {
  const version = (navigationVersions.get(iframe) ?? 0) + 1;
  navigationVersions.set(iframe, version);
  return version;
}

function isCurrentNavigation(
  iframe: HTMLIFrameElement,
  version: number,
): boolean {
  return navigationVersions.get(iframe) === version;
}

function clearGameLoadState(
  iframe: HTMLIFrameElement,
  resetTerminal = false,
): number | null {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  if (resetTerminal) delete iframeExt.__gameLoadTerminal;
  const timeout = iframeExt.__gameLoadTimeout;
  if (timeout) clearTimeout(timeout as ReturnType<typeof setTimeout>);
  iframeExt.__gameLoadTimeout = null;
  const startedAt = iframeExt.__gameLoadStartedAt;
  delete iframeExt.__gameLoadStartedAt;
  return typeof startedAt === "number" ? startedAt : null;
}

function finishGameLoadMetric(
  iframe: HTMLIFrameElement,
  status: "success" | "error",
  stage: "iframe-load" | "iframe-timeout" = "iframe-load",
): void {
  const startedAt = clearGameLoadState(iframe);
  if (startedAt === null) return;
  const tab = window.Lyra?.tabs?.find((candidate) => candidate.iframe === iframe);
  if (!tab?.isGame) return;
  const realUrl = decodeUrl(iframe.dataset.manualUrl || iframe.src || "");
  const gameHost = hostFromUrl(realUrl);
  const source: GameSourceKey = getStoredGameSource();
  const metric = {
    stage,
    source,
    status,
    durationMs:
      (typeof performance === "undefined" ? Date.now() : performance.now()) -
      startedAt,
  } as const;
  if (gameHost) recordGameMetric({ ...metric, urlHost: gameHost });
  else recordGameMetric(metric);
}

function armGameLoadTimeout(
  iframe: HTMLIFrameElement,
  version: number,
  tabId: number | null,
): void {
  const tab = window.Lyra?.tabs?.find((candidate) => candidate.iframe === iframe);
  if (!tab?.isGame) return;
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  iframeExt.__gameLoadStartedAt = startedAt;
  iframeExt.__gameLoadTimeout = setTimeout(() => {
    if (!isCurrentNavigation(iframe, version)) return;
    failGameNavigation(iframe, tabId, "iframe-timeout");
  }, GAME_LOAD_TIMEOUT_MS);
}

function isKnownGameErrorDocument(iframe: HTMLIFrameElement): boolean {
  try {
    const title = iframe.contentDocument?.title?.trim();
    return title === "404!!" || title === "Folio" || title === "Error";
  } catch {
    return false;
  }
}

function failGameNavigation(
  iframe: HTMLIFrameElement,
  tabId: number | null,
  stage: "iframe-load" | "iframe-timeout" = "iframe-load",
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  iframeExt.__gameLoadTerminal = "error";
  finishGameLoadMetric(iframe, "error", stage);
  hideLoading(tabId ?? undefined);
  syncGlobalLoadingState();
  const tab = window.Lyra?.tabs?.find((candidate) => candidate.iframe === iframe);
  if (tab?.isGame) window.Lyra.setPlayerStatus?.(tab.id, "error");
  iframe.parentElement?.classList.add("loaded");
}

function getTabIdFromIframe(iframe: HTMLIFrameElement): number | null {
  if (!iframe) return null;
  const tabId = iframe.dataset?.tabId;
  if (!tabId) return null;
  const parsedTabId = parseInt(tabId, 10);
  return Number.isNaN(parsedTabId) ? null : parsedTabId;
}

function pageStateUrl(tab: UrlTrackedTab | null | undefined): string | null {
  const url = tab?.pageState?.url;
  return typeof url === "string" && url && url !== "about:blank" ? url : null;
}

export function getBestKnownUrl(
  iframe: HTMLIFrameElement,
  tab?: UrlTrackedTab | null,
): string | null {
  if (tab?.extensionPage?.url) return tab.extensionPage.url;
  if (tab?.historyManager?.getCurrentUrl?.()) return tab.historyManager.getCurrentUrl();
  const trackedUrl = pageStateUrl(tab);
  if (trackedUrl) return trackedUrl;
  if (iframe.dataset.manualUrl) return iframe.dataset.manualUrl;
  try {
    const frameUrl = iframe.contentWindow?.location?.href;
    if (frameUrl && frameUrl !== "about:blank") return frameUrl;
  } catch (e) {}
  return iframe.src && iframe.src !== "about:blank" ? iframe.src : null;
}

function navigationUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin &&
        (parsed.pathname === "/f" || parsed.pathname.startsWith("/!!/"))) return decodeUrl(url);
  } catch {}
  return url;
}

export function historyEntry(iframe: HTMLIFrameElement) {
  try {
    return iframe.contentWindow?.navigation?.currentEntry ?? null;
  } catch { return null; }
}

export function navigateHistory(iframe: HTMLIFrameElement, delta: -1 | 1): void {
  const tab = window.Lyra.tabs?.find((candidate) => candidate.iframe === iframe);
  const history = tab?.historyManager;
  const target = history?.getTarget(delta);
  if (!history || !target) return;
  try {
    const navigation = iframe.contentWindow?.navigation;
    if (target.key && navigation?.entries().some((entry) => entry.key === target.key)) {
      clearGameLoadState(iframe, true);
      // Traverse this frame's entry, never the host's joint session history.
      const result = navigation.traverseTo(target.key);
      void result.committed?.catch(() => {});
      void result.finished?.catch(() => {});
      return;
    }
  } catch {}
  if (delta === -1) history.back();
  else history.forward();
  navigateIframeTo(iframe, target.url, "replace");
}

export function reloadIframe(iframe: HTMLIFrameElement): void {
  const tab = window.Lyra.tabs?.find((candidate) => candidate.iframe === iframe);
  const url = getBestKnownUrl(iframe, tab);
  if (!tab?.historyManager || !url) return;
  const version = beginNavigation(iframe);
  iframe.dataset.navigationVersion = String(version);
  tab.historyManager.begin("replace");
  installIframeLoadHandlers(iframe, tab.historyManager, tab.id, version);
  clearGameLoadState(iframe, true);
  armGameLoadTimeout(iframe, version, tab.id);
  showLoading(tab.id);
  iframe.parentElement?.classList.remove("loaded");
  try {
    iframe.contentWindow!.location.reload();
  } catch {
    navigateIframeTo(iframe, url, "replace");
  }
}

function applyPageStateToTab(tab: LyraTab): boolean {
  const pageState = tab.pageState;
  if (!pageState) return false;
  let applied = false;
  if (
    !tab.fixedTitle &&
    typeof pageState.title === "string" &&
    pageState.title.trim()
  ) {
    tab.title = pageState.title.trim();
    applied = true;
  }
  if (!tab.fixedFavicon && pageState.favicon) {
    tab.favicon = pageState.favicon;
    applied = true;
  }
  return applied;
}

function shouldRouteThroughFolio(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.origin === window.location.origin) return false;
    return true;
  } catch {
    return false;
  }
}

async function waitForFolioNavigationTransport(): Promise<void> {
  if (!window.Lyra?.waitForTransport) return;
  try {
    await window.Lyra.waitForTransport(8000);
  } catch (e: unknown) {
    console.warn(
      "iframe navigation: transport not ready; attempting recovery:",
      (e as Error).message,
      NEGATIVE,
    );
    const conn = (window as unknown as Record<string, unknown>)[
      "lyraConnection"
    ] as { recoverOnWake?: () => Promise<void> } | undefined;
    if (!conn?.recoverOnWake) throw e;
    try {
      await conn.recoverOnWake();
      await window.Lyra.waitForTransport?.(6000);
    } catch (recoveryError) {
      console.warn(
        "iframe navigation: recovery failed before folio navigation",
        NEGATIVE,
      );
      throw recoveryError;
    }
  }
}

async function prepareFolioNavigation(
  prepareRuntime: () => Promise<void> = ensureProxyRuntime,
  waitForTransport: () => Promise<void> = waitForFolioNavigationTransport,
): Promise<void> {
  await prepareRuntime();
  await waitForTransport();
}

async function navigateExternalThroughFolio(
  iframe: HTMLIFrameElement,
  url: string,
  version: number,
): Promise<void> {
  await prepareFolioNavigation();
  if (!isCurrentNavigation(iframe, version)) return;
  const folio = await import("../proxy/folio");
  await folio.navigateFolioIframe(iframe, url, () =>
    isCurrentNavigation(iframe, version),
  );
}

function detachContentWindowListeners(iframe: HTMLIFrameElement): void {
  try {
    const iframeWindow = iframe.contentWindow as
      | (Window & Record<string, unknown>)
      | null;
    if (!iframeWindow) return;
    if (typeof iframeWindow.__lyraHistoryCleanup === "function") {
      iframeWindow.__lyraHistoryCleanup();
      delete iframeWindow.__lyraHistoryCleanup;
    }
    if (iframeWindow.__beforeUnloadHandler) {
      iframeWindow.removeEventListener(
        "beforeunload",
        iframeWindow.__beforeUnloadHandler as EventListener,
      );
      iframeWindow.__beforeUnloadHandler = null;
    }
    if (iframeWindow.__domContentLoadedHandler) {
      iframeWindow.removeEventListener(
        "DOMContentLoaded",
        iframeWindow.__domContentLoadedHandler as EventListener,
      );
      iframeWindow.__domContentLoadedHandler = null;
    }
    if (iframeWindow.__lyraFocusHandler) {
      iframeWindow.removeEventListener(
        "mousedown",
        iframeWindow.__lyraFocusHandler as EventListener,
        true,
      );
      iframeWindow.__lyraFocusHandler = null;
    }
  } catch (e) {
    console.warn("unable to detach iframe window listeners:", e, NEGATIVE);
  }
}

export function stopIframeLoading(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const version = beginNavigation(iframe);
  const tabId = getTabIdFromIframe(iframe);
  const currentTab = window.Lyra.tabs?.find((tab) => tab.id === tabId);
  if (currentTab?.historyManager) {
    installIframeLoadHandlers(iframe, currentTab.historyManager, tabId, version);
  }
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;

  clearGameLoadState(iframe, true);
  if (iframeExt.__usableTimeout) {
    clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
    iframeExt.__usableTimeout = null;
  }

  try {
    if (iframe.contentWindow) iframe.contentWindow.stop();
  } catch (e) {
    console.warn("could not stop iframe loading:", e, NEGATIVE);
  }

  updateTabDetails(iframe);

  hideLoading(tabId ?? undefined);
  syncGlobalLoadingState();
  iframe.parentElement?.classList.add("loaded");

  const tab = window.Lyra?.tabs?.find((tab) => tab.iframe === iframe);
  tab?.historyManager?.cancel();
  const currentUrl = getBestKnownUrl(iframe, tab);

  if (tab && currentUrl && currentUrl !== "about:blank") {
    updateHistoryUI(tab, {
      currentUrl: tab.historyManager?.getCurrentUrl?.() ?? currentUrl,
      canGoBack: tab.historyManager?.canGoBack?.() ?? false,
      canGoForward: tab.historyManager?.canGoForward?.() ?? false,
    });
  }
}

export function navigateIframeTo(iframe: HTMLIFrameElement, url: string, mode: "push" | "replace" = "push"): void {
  if (!url || !iframe) return;
  const navigationVersion = beginNavigation(iframe);
  clearExtensionPageForNavigation(iframe);
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const tab = window.Lyra.tabs!.find((t) => t.iframe === iframe);
  tab?.historyManager?.begin(mode);
  iframe.dataset.navigationVersion = String(navigationVersion);
  const historyManager = iframeExt.__lyraHistoryManager as
    | IframeHistoryManager
    | undefined;
  if (historyManager) {
    installIframeLoadHandlers(
      iframe,
      historyManager,
      tab?.id ??
        (iframeExt.__lyraTabId as number | null | undefined) ??
        getTabIdFromIframe(iframe),
      navigationVersion,
    );
  }
  if (tab) {
    updateHistoryUI(tab, {
      currentUrl: url,
      canGoBack: tab.historyManager?.canGoBack?.() ?? false,
      canGoForward: tab.historyManager?.canGoForward?.() ?? false,
    });
  }
  showLoading((tab?.id || getTabIdFromIframe(iframe)) ?? undefined);
  if (tab) getRivet()?.notifyTabUpdated(tab.id, { status: "loading", url });
  window.Lyra.isLoading = true;
  delete iframe.dataset.reloadAttempted;
  iframe.parentElement?.classList.remove("loaded");

  if (tab) {
    delete tab.pageState;
    if (!tab.fixedTitle) {
      tab.title = "fetching data...";
    }
    if (!tab.fixedFavicon) {
      tab.favicon = null;
    }
    if (window.Lyra.renderTabs)
      (window.Lyra.renderTabs as () => void)();
  }

  iframe.dataset.navigationStarted = "true";
  iframe.removeAttribute("srcdoc");
  delete iframe.dataset.manualUrl;
  clearGameLoadState(iframe, true);
  armGameLoadTimeout(
    iframe,
    navigationVersion,
    tab?.id ?? getTabIdFromIframe(iframe),
  );

  if (iframeExt.__usableTimeout) {
    clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
    iframeExt.__usableTimeout = null;
  }

  const shouldUseFolio = shouldRouteThroughFolio(url);
  let isProxyUrl = false;
  try {
    const parsed = new URL(url, window.location.origin);
    isProxyUrl =
      parsed.origin === window.location.origin &&
      (parsed.pathname === "/f" && parsed.searchParams.has("s"));
  } catch {}
  if (shouldUseFolio) {
    void navigateExternalThroughFolio(iframe, url, navigationVersion).catch((error) => {
      if (!isCurrentNavigation(iframe, navigationVersion)) return;
      console.error("iframe navigation through folio failed:", error, NEGATIVE);
      failGameNavigation(
        iframe,
        tab?.id ?? getTabIdFromIframe(iframe),
      );
    });
  } else if (isProxyUrl && window.Lyra?.waitForTransport) {
    (async () => {
      try {
        await window.Lyra.waitForTransport?.(8000);
      } catch (e: unknown) {
        console.warn(
          "iframe navigation: transport not ready; attempting recovery:",
          (e as Error).message,
          NEGATIVE,
        );
        const conn = (window as unknown as Record<string, unknown>)[
          "lyraConnection"
        ] as { recoverOnWake?: () => Promise<void> } | undefined;
        if (conn?.recoverOnWake) {
          try {
            await conn.recoverOnWake();
            await window.Lyra.waitForTransport?.(6000);
          } catch {
            console.warn(
              "iframe navigation: recovery failed; continuing without recovery",
              NEGATIVE,
            );
          }
        }
      }
      if (!isCurrentNavigation(iframe, navigationVersion)) return;
      iframe.src = url;
    })();
  } else {
    iframe.src = url;
  }
}

export function clearExtensionPageForNavigation(
  iframe: HTMLIFrameElement,
  tabOverride?: Pick<
    LyraTab,
    "extensionPage" | "fixedTitle" | "fixedFavicon"
  >,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const cleanup = iframeExt.__rivetExtensionPageCleanup;
  if (typeof cleanup === "function") {
    cleanup();
    if (iframeExt.__rivetExtensionPageCleanup === cleanup) {
      delete iframeExt.__rivetExtensionPageCleanup;
    }
  }
  const tab =
    tabOverride ??
    window.Lyra.tabs?.find((candidate) => candidate.iframe === iframe);
  if (!tab?.extensionPage) return;
  delete tab.extensionPage;
  tab.fixedTitle = false;
  tab.fixedFavicon = false;
  delete iframe.dataset.manualUrl;
}

export function cleanupIframe(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  beginNavigation(iframe);
  window.Lyra?.releaseFolioFrame?.(iframe);
  clearExtensionPageForNavigation(iframe);
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  clearGameLoadState(iframe, true);
  const handlers = iframeExt.__lyraInternalHandlers as
    | IframeInternalHandlers
    | null
    | undefined;
  if (handlers) {
    iframe.removeEventListener("error", handlers.onError);
    iframe.removeEventListener("load", handlers.onLoad);
    iframeExt.__lyraInternalHandlers = null;
  }
  detachContentWindowListeners(iframe);
  iframe.removeAttribute("srcdoc");
  iframe.removeAttribute("data-navigation-started");
  iframe.removeAttribute("data-reload-attempted");
  iframe.removeAttribute("data-manual-url");
  delete iframe.dataset.reloadCount;
  try {
    iframe.contentWindow?.stop?.();
  } catch (e) {}
  try {
    iframe.src = "about:blank";
  } catch (e) {}
  const wrapper = iframe.parentElement;
  if (wrapper) {
    wrapper.style.boxShadow = "";
    wrapper.classList.remove(
      "loaded",
      "active",
      "active-split-left",
      "active-split-right",
      "active-focus",
    );
  }
}

function updateTabDetails(iframe: HTMLIFrameElement): void {
  const tabToUpdate = window.Lyra.tabs!.find(
    (tab) => tab.iframe === iframe,
  );
  if (!tabToUpdate) return;
  const usedPageState = applyPageStateToTab(tabToUpdate);
  if (usedPageState) {
    if (window.Lyra.renderTabs) (window.Lyra.renderTabs as () => void)();
    return;
  }
  const prevTitle = tabToUpdate.title;
  const prevFavicon = tabToUpdate.favicon;
  let isReloading = false;
  try {
    const iframeWindow = iframe.contentWindow!;
    const doc = iframeWindow.document;
    const currentProxiedUrl =
      iframe.dataset.manualUrl || iframeWindow.location.href;
    const realUrl = decodeUrl(currentProxiedUrl);

    const newTitle = (doc.title || "").trim();
    if (!tabToUpdate.fixedTitle) {
      if (newTitle) {
        tabToUpdate.title = newTitle;
      } else if (tabToUpdate.title === "fetching data...") {
        try {
          tabToUpdate.title = new URL(realUrl).hostname || "new tab";
        } catch (e) {
          tabToUpdate.title = "new tab";
        }
      }
    }

    if (
      tabToUpdate.title === "404!!" ||
      tabToUpdate.title === "Folio" ||
      tabToUpdate.title === "Error"
    ) {
      const MAX_RELOADS = 3;
      const MIN_INTERVAL_MS = 1200;
      let reloadCount = parseInt(iframe.dataset.reloadCount || "0", 10);
      const lastReloadAt = parseInt(iframe.dataset.lastReloadAt || "0", 10);
      const now = Date.now();
      const cooldownReached =
        !lastReloadAt || now - lastReloadAt > MIN_INTERVAL_MS;
      const isActiveTab = document.body.classList.contains("split-view")
        ? tabToUpdate.id === (window.Lyra as any)?.splitPair?.left ||
          tabToUpdate.id === (window.Lyra as any)?.splitPair?.right ||
          tabToUpdate.id === (window.Lyra as any)?.getActiveTab?.()?.id
        : tabToUpdate.id === (window.Lyra as any)?.getActiveTab?.()?.id;
      if (reloadCount < MAX_RELOADS && cooldownReached && isActiveTab) {
        iframe.dataset.reloadCount = (reloadCount + 1).toString();
        iframe.dataset.lastReloadAt = now.toString();
        isReloading = true;
        iframe.parentElement?.classList.remove("loaded");

        const currentUrl =
          pageStateUrl(tabToUpdate) ||
          iframe.dataset.manualUrl ||
          decodeUrl(iframe.src);
        navigateIframeTo(iframe, currentUrl);
        return;
      }
    }
    const iconLink = doc.querySelector("link[rel*='icon']");
    if (!tabToUpdate.fixedFavicon) {
          const gameCover = getLoadedGameCover(realUrl);

      if (gameCover) {
        tabToUpdate.favicon = gameCover;
      } else if (iconLink) {
        const decodedFavicon = decodeUrl((iconLink as HTMLLinkElement).href);
        tabToUpdate.favicon = decodedFavicon
          ? getProxyUrl(decodedFavicon)
          : null;
      } else {
        try {
          tabToUpdate.favicon = getProxyUrl(
            new URL("favicon.ico", realUrl).href,
          );
        } catch (e) {
          tabToUpdate.favicon = null;
        }
      }
    }
  } catch (e) {
    tabToUpdate.title = prevTitle || "new tab";
    if (!tabToUpdate.fixedFavicon) {
      const proxyUrl = iframe.dataset.manualUrl || iframe.src;
        const gameCover = getLoadedGameCover(decodeUrl(proxyUrl));
      tabToUpdate.favicon = gameCover || prevFavicon || null;
    }
  } finally {
    if (!isReloading && window.Lyra.renderTabs)
      (window.Lyra.renderTabs as () => void)();
  }
}

function setupIframeContentListeners(
  iframe: HTMLIFrameElement,
  historyManager: NonNullable<LyraTab["historyManager"]>,
  tabId: number | null,
): void {
  try {
    const iframeWindow = iframe.contentWindow;
    const hasManualUrl = !!iframe.dataset.manualUrl;
    const isBlank = iframeWindow?.location?.href === "about:blank";
    if (!iframeWindow || iframeWindow === window || (isBlank && !hasManualUrl))
      return;

    detachContentWindowListeners(iframe);
    const navigation = iframeWindow.navigation;
    const hasPageStatePlugin = Boolean((iframeWindow as Window & { __lyraFolioPageStateInstalled?: boolean }).__lyraFolioPageStateInstalled);
    if (navigation && !hasPageStatePlugin) {
      const onEntryChange = (event: NavigationCurrentEntryChangeEvent) => {
        const url = navigationUrl(iframeWindow.location.href);
        historyManager.observe(url, event.navigationType ?? "metadata", navigation.currentEntry?.key);
      };
      navigation.addEventListener("currententrychange", onEntryChange);
      (iframeWindow as Window & Record<string, unknown>).__lyraHistoryCleanup = () =>
        navigation.removeEventListener("currententrychange", onEntryChange);
    }

    const handleNav = (type = "history-push"): void => {
      const newUrlInIframe = iframeWindow.location.href;
      const baseManualUrl = iframe.dataset.manualUrl;
      let finalUrlToPush = newUrlInIframe;
      if (baseManualUrl && newUrlInIframe.startsWith("about:blank")) {
        try {
          const newUrlObj = new URL(newUrlInIframe, window.location.origin);
          const baseManualUrlObj = new URL(baseManualUrl);
          baseManualUrlObj.hash = newUrlObj.hash;
          baseManualUrlObj.search = newUrlObj.search;
          finalUrlToPush = baseManualUrlObj.toString();
        } catch (e) {
          finalUrlToPush = newUrlInIframe;
        }
      }
      if (finalUrlToPush !== "about:blank") {
        historyManager.observe(navigationUrl(finalUrlToPush), type);
      }
    };

    if (!navigation && !hasPageStatePlugin && !(iframeWindow.history.pushState as any).__isPatched) {
      const originalPushState = iframeWindow.history.pushState;
      (iframeWindow as any).history.pushState = function (
        ...args: Parameters<typeof History.prototype.pushState>
      ) {
        originalPushState.apply(this, args);
        handleNav();
      };
      (iframeWindow.history.pushState as any).__isPatched = true;
    }
    if (!navigation && !hasPageStatePlugin && !(iframeWindow.history.replaceState as any).__isPatched) {
      const originalReplaceState = iframeWindow.history.replaceState;
      (iframeWindow as any).history.replaceState = function (
        ...args: Parameters<typeof History.prototype.replaceState>
      ) {
        originalReplaceState.apply(this, args);
        handleNav("history-replace");
      };
      (iframeWindow.history.replaceState as any).__isPatched = true;
    }

    if (!navigation && !hasPageStatePlugin) {
      const onPopState = () => handleNav("popstate");
      const onHashChange = () => handleNav("hashchange");
      iframeWindow.addEventListener("popstate", onPopState);
      iframeWindow.addEventListener("hashchange", onHashChange);
      (iframeWindow as Window & Record<string, unknown>).__lyraHistoryCleanup = () => {
        iframeWindow.removeEventListener("popstate", onPopState);
        iframeWindow.removeEventListener("hashchange", onHashChange);
      };
    }

    const beforeUnloadHandler = () => {
      showLoading(tabId ?? undefined);
      window.Lyra.isLoading = true;
      iframe.parentElement?.classList.remove("loaded");
      const tab = window.Lyra.tabs!.find((t) => t.id === tabId);
      if (tab) {
        if (!tab.fixedTitle) {
          tab.title = "fetching data...";
        }
        if (!tab.fixedFavicon) {
          tab.favicon = null;
        }
        if (window.Lyra.renderTabs)
          (window.Lyra.renderTabs as () => void)();
      }
    };
    (iframeWindow as Window & Record<string, unknown>).__beforeUnloadHandler =
      beforeUnloadHandler;
    iframeWindow.addEventListener("beforeunload", beforeUnloadHandler);

    const domLoadedHandler = () => {
      updateTabDetails(iframe);
    };
    (
      iframeWindow as Window & Record<string, unknown>
    ).__domContentLoadedHandler = domLoadedHandler;
    iframeWindow.addEventListener("DOMContentLoaded", domLoadedHandler);

    const mouseDownHandler = () => {
      const focusEvent = new CustomEvent("iframe-focus", {
        detail: { tabId },
        bubbles: false,
      });
      iframe.dispatchEvent(focusEvent);
    };
    (iframeWindow as Window & Record<string, unknown>).__lyraFocusHandler =
      mouseDownHandler;
    iframeWindow.addEventListener("mousedown", mouseDownHandler, true);
  } catch (e) {
    console.warn("could not attach listeners to iframe content", NEGATIVE);
  }
}

let _searchInputNav: HTMLInputElement | null = null;
let _backIcon: HTMLElement | null = null;
let _forwardIcon: HTMLElement | null = null;

function getNavEls() {
  if (!_searchInputNav?.isConnected)
    _searchInputNav = document.getElementById(
      "searchInputt",
    ) as HTMLInputElement | null;
  if (!_backIcon?.isConnected)
    _backIcon = document.getElementById("backIcon");
  if (!_forwardIcon?.isConnected)
    _forwardIcon = document.getElementById("forwardIcon");
}

export function updateHistoryUI(
  activeTab: LyraTab,
  { currentUrl, canGoBack, canGoForward }: HistoryUIState,
): void {
  if (activeTab?.id !== store.activeTabId) return;
  getNavEls();
  const stillExists =
    activeTab && window.Lyra?.tabs?.some((tab) => tab.id === activeTab.id);

  if (!activeTab || !activeTab.iframe || !stillExists) {
    if (_searchInputNav) _searchInputNav.value = "";
    if (_backIcon) _backIcon.classList.add("disabled");
    if (_forwardIcon) _forwardIcon.classList.add("disabled");
    currentUrlSignal.value = "";
    return;
  }

  const { iframe } = activeTab;

  for (const [element, enabled] of [[_backIcon, canGoBack], [_forwardIcon, canGoForward]] as const) {
    if (!element) continue;
    element.classList.toggle("disabled", !enabled);
    element.setAttribute("aria-disabled", String(!enabled));
    element.tabIndex = enabled ? 0 : -1;
  }

  if (_searchInputNav) {
    const trackedPageUrl = pageStateUrl(activeTab);
    let displayUrl: string | null | undefined =
      currentUrl ?? trackedPageUrl ?? activeTab.extensionPage?.url;
    if (displayUrl === undefined || displayUrl === null) {
      displayUrl = getBestKnownUrl(iframe, activeTab);
    }

    const decoded = navigationUrl(displayUrl ?? "");
    let displayText: string = decoded;

    if (activeTab.extensionPage && !trackedPageUrl) {
      const title = activeTab.title.trim().toLowerCase() || "extension";
      displayText = `extension: ${title} / ${activeTab.extensionPage.page}`;
    }

    try {
      const custom = getLoadedGameDisplayLabel(decoded);
      if (!activeTab.extensionPage && custom) displayText = custom as string;
    } catch (e) {}

    if (!activeTab.extensionPage && displayText === decoded) {
      const animeLabel = getAnimeDisplayLabel(decoded);
      if (animeLabel) displayText = animeLabel;
    }

    if (
      displayText === decoded &&
      activeTab.gameDisplayByUrl &&
      typeof activeTab.gameDisplayByUrl === "object"
    ) {
      const normalized = normalizeGameHistoryUrl(decoded);
      const remembered = normalized
        ? (activeTab.gameDisplayByUrl as Record<string, string>)[normalized]
        : null;
      if (remembered) displayText = remembered;
    }

    if (displayText === decoded && activeTab.fixedTitle && activeTab.isGame) {
      const rawTitle =
        typeof activeTab.title === "string" ? activeTab.title.trim() : "";
      const safeTitle = rawTitle.toLowerCase();
      if (
        safeTitle &&
        safeTitle !== "fetching data..." &&
        safeTitle !== "new tab"
      ) {
        const source = getStoredGameSource();
        displayText = `game: ${safeTitle} / source: ${source}`;
      }
    }

    if (document.activeElement !== _searchInputNav) {
      _searchInputNav.value =
        displayText === "about:blank" || !displayText ? "" : displayText;
    }

    currentUrlSignal.value = decoded || "";
  }
}

function installIframeLoadHandlers(
  iframe: HTMLIFrameElement,
  historyManager: IframeHistoryManager,
  tabId: number | null,
  navigationVersion: number,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const previousHandlers = iframeExt.__lyraInternalHandlers as
    | IframeInternalHandlers
    | null
    | undefined;
  if (previousHandlers) {
    iframe.removeEventListener("error", previousHandlers.onError);
    iframe.removeEventListener("load", previousHandlers.onLoad);
  }

  const onError = (): void => {
    if (!isCurrentNavigation(iframe, navigationVersion)) return;
    iframeExt.__gameLoadTerminal = "error";
    finishGameLoadMetric(iframe, "error");
    if (iframeExt.__usableTimeout) {
      clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
      iframeExt.__usableTimeout = null;
    }
    hideLoading(tabId ?? undefined);
    syncGlobalLoadingState();
    const tab = window.Lyra?.tabs?.find((candidate) => candidate.iframe === iframe);
    if (tab?.isGame) window.Lyra.setPlayerStatus?.(tab.id, "error");
    iframe.parentElement?.classList.add("loaded");
    if (tab) getRivet()?.notifyTabUpdated(tab.id, { status: "complete" });
  };

  const onLoad = (): void => {
    if (!isCurrentNavigation(iframe, navigationVersion)) return;
    if (iframeExt.__gameLoadTerminal === "error") return;
    const tab = window.Lyra?.tabs?.find((tab) => tab.iframe === iframe);
    if (tab?.isGame && isKnownGameErrorDocument(iframe)) {
      failGameNavigation(iframe, tabId);
      updateTabDetails(iframe);
      return;
    }
    iframeExt.__gameLoadTerminal = "success";
    finishGameLoadMetric(iframe, "success");
    if (iframeExt.__usableTimeout) {
      clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
      iframeExt.__usableTimeout = null;
    }

    if (tab?.isGame && tab.playerStatus === "error") {
      window.Lyra.setPlayerStatus?.(tab.id, "idle");
    }
    let newUrl: string | undefined;
    try {
      const win = iframe.contentWindow;
      const nativeUrl = win?.location.href;
      if (nativeUrl && nativeUrl !== "about:blank") {
        newUrl = navigationUrl(nativeUrl);
        // The proxy reports every commit in order; a load event must not race
        // that stream and insert its final entry ahead of queued SPA entries.
        if (!(win as Window & { __lyraFolioPageStateInstalled?: boolean }).__lyraFolioPageStateInstalled) {
          historyManager.observe(newUrl, win?.navigation?.activation?.navigationType ?? "load", win?.navigation?.currentEntry?.key);
        }
      }
    } catch {}

    updateTabDetails(iframe);

    hideLoading(tabId ?? undefined);
    syncGlobalLoadingState();
    iframe.parentElement?.classList.add("loaded");

    if (tab) {
      getRivet()?.notifyTabUpdated(tab.id, {
        status: "complete",
        ...(newUrl ? { url: newUrl } : {}),
        title: tab.title,
        favIconUrl: tab.favicon ?? "",
      });
    }

    setupIframeContentListeners(iframe, historyManager, tabId);
  };

  iframe.addEventListener("error", onError);
  iframe.addEventListener("load", onLoad);
  iframeExt.__lyraInternalHandlers = {
    onError,
    onLoad,
    version: navigationVersion,
  } satisfies IframeInternalHandlers;
}

export function initializeIframe(
  iframe: HTMLIFrameElement,
  historyManager: IframeHistoryManager,
  tabId: number | null,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  iframeExt.__lyraHistoryManager = historyManager;
  iframeExt.__lyraTabId = tabId;
  installIframeLoadHandlers(
    iframe,
    historyManager,
    tabId,
    navigationVersions.get(iframe) ?? 0,
  );
}
