import { BANGS, SEARCH_ENGINES } from "../../core/config/config.ts";
import { DEFAULT_SETTINGS } from "../../core/config/settingsOptions.ts";
import { useEffect } from "preact/hooks";
import {
  showBrowserView,
  store,
} from "../../state/store.ts";
import {
  clearExtensionPageForNavigation,
  navigateIframeTo,
  updateHistoryUI,
} from "../../core/browser/iframe.ts";
import { getProxyUrl } from "../../core/runtime/utils.ts";
import { warmProxyRuntime } from "../../core/proxy/proxyRuntime.ts";

interface TabLike {
  id?: number;
  iframe: HTMLIFrameElement;
  isUrlLoaded: boolean;
  pageState?: unknown;
  extensionPage?: {
    extId: string;
    page: string;
    url: string;
  };
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  historyManager: {
    getCurrentUrl(): string;
    canGoBack(): boolean;
    canGoForward(): boolean;
  };
}

interface SearchInputBindingsOptions {
  inputId: string;
  suggestionsId?: string | null;
  syncHistory?: boolean;
}

function isBangQuery(query: string): boolean {
  return query.trim().startsWith("!");
}

function parseBangQuery(
  query: string,
): { bang: string; searchQuery: string } | null {
  const trimmed = query.trim();
  if (!isBangQuery(trimmed)) return null;
  const parts = trimmed.substring(1).split(" ");
  if (parts.length === 0) return null;
  const bang = parts[0]!.toLowerCase();
  const searchQuery = parts.slice(1).join(" ");
  return { bang, searchQuery };
}

function executeBang(query: string): string | null {
  const parsed = parseBangQuery(query);
  if (!parsed) return null;
  const { bang, searchQuery } = parsed;
  const bangData = (BANGS as Record<string, { url: string }>)[bang];
  if (!bangData) return null;
  return bangData.url.includes("{query}")
    ? bangData.url.replace("{query}", encodeURIComponent(searchQuery))
    : bangData.url;
}

function generateSearchUrl(query: string): string {
  query = query.trim();
  const searchEngine =
    localStorage.getItem("searchEngine") ?? DEFAULT_SETTINGS.searchEngine;
  const baseUrl =
    (SEARCH_ENGINES as Record<string, string>)[searchEngine] ||
    (SEARCH_ENGINES as Record<string, string>)[DEFAULT_SETTINGS.searchEngine]!;
  if (/^[a-zA-Z]+:\/\//.test(query)) {
    try {
      new URL(query);
      return query;
    } catch {}
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(query))
    return `http://${query}`;
  if (!query.includes(" ")) {
    try {
      const urlWithHttps = new URL(`https://${query}`);
      const parts = urlWithHttps.hostname.split(".");
      if (
        urlWithHttps.hostname.includes(".") &&
        (parts[parts.length - 1]?.length ?? 0) >= 2 &&
        !/^\d+$/.test(parts[parts.length - 1] ?? "")
      ) {
        return urlWithHttps.toString();
      }
    } catch {}
  }
  const finalUrl = baseUrl + encodeURIComponent(query);
  return finalUrl;
}

function getInternalRouteUrl(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, window.location.origin);
    if (
      url.origin === window.location.origin &&
      /^\/stream\/anime(?:$|[/?#])/.test(url.pathname + url.search + url.hash)
    ) {
      return url.href;
    }
  } catch {}
  return null;
}

export async function handleSearch(
  query: string,
  activeTab: TabLike,
  _gameName?: string,
): Promise<void> {
  if (!activeTab || !query.trim()) return;
  showBrowserView();
  activeTab.isUrlLoaded = true;
  delete activeTab.pageState;
  clearExtensionPageForNavigation(activeTab.iframe, activeTab);
  const internalRouteUrl = getInternalRouteUrl(query);
  if (internalRouteUrl) {
    navigateIframeTo(activeTab.iframe, internalRouteUrl);
    return;
  }
  const searchURL = executeBang(query) || generateSearchUrl(query);
  const isGame =
    Boolean(_gameName) ||
    /jsdelivr|googleusercontent|githack|selenite|wasm\.rip|velara|gn-math\.dev|truffled|d20q8iy6t6707a\.cloudfront\.net/.test(
      searchURL,
    );
  if (isGame) {
    let processedURL = searchURL;
    if (
      !processedURL.includes("?") &&
      !processedURL.split("/").pop()!.includes(".")
    ) {
      processedURL = processedURL.endsWith("/")
        ? processedURL + "index.html"
        : processedURL + "/index.html";
    }
    navigateIframeTo(activeTab.iframe, getProxyUrl(processedURL));
  } else {
    const finalUrlToLoad = searchURL.includes("/assets/gs/")
      ? new URL(searchURL, window.location.origin).href
      : searchURL;

    navigateIframeTo(activeTab.iframe, finalUrlToLoad);
  }
}

export function useSearchInputBindings({
  inputId,
  suggestionsId,
  syncHistory = false,
}: SearchInputBindingsOptions): void {
  useEffect(() => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;

    const onInput = () => {
      if (!syncHistory) return;
      const activeTab = store.getActiveTab();
      if (!activeTab?.historyManager) return;
      updateHistoryUI(activeTab as any, {
        currentUrl: input.value,
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    };

    const onFocus = () => {
      if (!syncHistory) return;
      const activeTab = store.getActiveTab();
      if (!activeTab?.historyManager) return;
      updateHistoryUI(activeTab as any, {
        currentUrl: activeTab.historyManager.getCurrentUrl(),
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    };

    const onMouseEnter = () => {
      warmProxyRuntime();
    };

    const onKeyup = async (e: KeyboardEvent) => {
      if (e.key !== "Enter" || document.activeElement !== input) return;
      const suggestions = suggestionsId
        ? document.getElementById(suggestionsId)
        : null;
      if (
        suggestions?.style.display === "block" &&
        suggestions.querySelector(".active")
      ) {
        return;
      }
      await (window as any).Lyra?.handleSearch?.(input.value.trim());
      if (suggestions) suggestions.style.display = "none";
      input.blur();
    };

    input.addEventListener("input", onInput);
    input.addEventListener("focus", onFocus);
    input.addEventListener("mouseenter", onMouseEnter);
    input.addEventListener("keyup", onKeyup);

    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("mouseenter", onMouseEnter);
      input.removeEventListener("keyup", onKeyup);
    };
  }, [inputId, suggestionsId, syncHistory]);
}
