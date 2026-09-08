import { useCallback } from "preact/hooks";
import { store, useStore } from "../../state/store.ts";
import {
  getBestKnownUrl,
  reloadIframe,
  navigateHistory,
  stopIframeLoading,
} from "../../core/browser/iframe.ts";
import { useSearchInputBindings } from "../../features/search/search.ts";
import { currentUrlSignal } from "../../core/ui/uiSignals";
import { toast } from "../../core/ui/toast.ts";
import { NEGATIVE } from "../../core/runtime/messages.ts";
import ExtensionMenu from "./ExtensionMenu.tsx";
import {
  IconSidebar,
  IconArrowLeft,
  IconArrowRight,
  IconCrossMedium,
  IconArrowRotateClockwise,
  IconHomeOpen,
  IconFullScreen,
  IconSplit,
  IconCode,
  IconChainLink4,
} from "../icons";
import { loadNewTabModal } from "../../app/loaders.ts";

function CopyLinkIcon() {
  const handleClick = useCallback(async () => {
    const url = currentUrlSignal.value;
    if (!url || url === "about:blank") return;
    const shareUrl = `${window.location.origin}/s?=${encodeURIComponent(url)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("url copied", undefined, 2000);
    } catch {}
  }, []);

  return <IconChainLink4 class="omnibox-icon" onClick={handleClick} />;
}

declare global {
  interface Window {
    eruda?: {
      init(): void;
      show(): void;
      destroy(): void;
    };
  }
}

let loadingTimeoutId: ReturnType<typeof setTimeout> | undefined;

function injectEruda(iframe: HTMLIFrameElement) {
  if (!iframe?.contentDocument || !iframe?.contentWindow) return;

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;

  if (doc.getElementById("eruda")) {
    try {
      win.eruda?.init();
      win.eruda?.show();
    } catch (e) {}
    return;
  }

  function doInject() {
    try {
      if (doc.getElementById("eruda")) {
        try {
          win.eruda?.init();
          win.eruda?.show();
        } catch (e) {}
        return;
      }

      if (loadingTimeoutId) clearTimeout(loadingTimeoutId);
      loadingTimeoutId = setTimeout(() => {
        try {
          const script = doc.getElementById("eruda");
          if (script) script.remove();
        } catch (e) {}
      }, 15000);

      const script = doc.createElement("script");
      script.id = "eruda";
      script.src = "/!!/https://cdn.jsdelivr.net/npm/eruda";
      script.async = true;
      script.onload = () => {
        clearTimeout(loadingTimeoutId);
        setTimeout(() => {
          try {
            win.eruda?.init();
            win.eruda?.show();
          } catch (e) {}
        }, 0);
      };
      script.onerror = () => {
        clearTimeout(loadingTimeoutId);
        try {
          script.remove();
        } catch (e) {}
      };

      let target = doc.head;
      if (!target) {
        target = doc.documentElement || doc.body;
      }
      if (!target) {
        console.warn(
          "eruda: no injection target found in iframe document",
          NEGATIVE,
        );
        return;
      }
      target.appendChild(script);
    } catch (err) {
      console.error("eruda injection failed:", err, NEGATIVE);
    }
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", doInject, { once: true });
  } else {
    doInject();
  }
}

function toggleEruda() {
  const activeTab = store.getActiveTab();
  if (!activeTab?.iframe) return;
  const iframe = activeTab.iframe;
  const win = iframe.contentWindow;
  if (!win) return;
  try {
    const isActive = iframe.dataset.erudaActive === "true";
    if (isActive && win.eruda) {
      if (typeof win.eruda.destroy === "function") win.eruda.destroy();
      iframe.dataset.erudaActive = "false";
    } else {
      iframe.dataset.erudaActive = "true";
      injectEruda(iframe);
    }
  } catch (err) {
    console.error("eruda toggle failed:", err, NEGATIVE);
  }
}

export default function NavBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair);
  const isPickingSplitTab = useStore((s) => s.isPickingSplitTab);

  const handleBack = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    navigateHistory(activeTab.iframe, -1);
  }, []);

  const handleForward = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    navigateHistory(activeTab.iframe, 1);
  }, []);

  const handleRefresh = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    if (activeTab.isLoading) stopIframeLoading(activeTab.iframe);
    else reloadIframe(activeTab.iframe);
  }, []);

  const handleFullscreen = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    const iframe = activeTab.iframe;
    const el = iframe as HTMLIFrameElement & {
      mozRequestFullScreen?(): void;
      webkitRequestFullscreen?(): void;
    };
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.mozRequestFullScreen) el.mozRequestFullScreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }, []);

  const handleHome = useCallback((e: MouseEvent) => {
    e.preventDefault();
    store.resetSession();
  }, []);

  const handleSplitView = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const wasPicking = store.isPickingSplitTab;
    store.toggleSplitView();
    if (store.isPickingSplitTab) {
      (window as any).showNewTabModal?.();
    } else if (wasPicking) {
      (window as any).hideNewTabModal?.();
    }
  }, []);

  const handleSidebarToggle = useCallback((e: MouseEvent) => {
    e.preventDefault();
    document.body.classList.toggle("sidebar-hidden");
    localStorage.setItem(
      "sidebarHidden",
      String(document.body.classList.contains("sidebar-hidden")),
    );
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  useSearchInputBindings({
    inputId: "searchInputt",
    suggestionsId: "suggestions-container-nav",
    syncHistory: true,
  });

  const isSplitPairDefined =
    splitPair.left !== null && splitPair.right !== null;
  const splitBtnDisabled =
    tabs.length <= 1 && !isSplitPairDefined && !isPickingSplitTab;
  const splitBtnActive = isSplitPairDefined || isPickingSplitTab;

  return (
    <div class="main-nav">
      <div class="nav-controls">
        <a id="toggle-sidebar-btn" href="#" onClick={handleSidebarToggle}>
          <IconSidebar />
        </a>
        <a
          id="backIcon"
          class="disabled"
          aria-disabled="true"
          tabIndex={-1}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleBack();
          }}
        >
          <IconArrowLeft />
        </a>
        <a
          id="forwardIcon"
          class="disabled"
          aria-disabled="true"
          tabIndex={-1}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleForward();
          }}
        >
          <IconArrowRight />
        </a>
        <a
          id="refreshIcon"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleRefresh();
          }}
        >
          {activeTab?.isLoading ? (
            <IconCrossMedium />
          ) : (
            <IconArrowRotateClockwise />
          )}
        </a>
      </div>
      <div class="omnibox">
        <div class="omnibox-input-wrap">
          <CopyLinkIcon />
          <input
            type="text"
            id="searchInputt"
            placeholder={
              activeTab?.isLoading
                ? "fetching url... (˶˃ ᵕ ˂˶)"
                : "search or enter url (˶>⩊<˶)"
            }
            autocomplete="off"
          />
        </div>
        <div id="suggestions-container-nav" class="suggestions-box"></div>
      </div>
      <div class="window-controls">
        <ExtensionMenu tabId={activeTabId} />
        <a id="home-btn" href="/" onClick={handleHome}>
          <IconHomeOpen />
        </a>
        <a
          id="fullscreenBtn"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleFullscreen();
          }}
        >
          <IconFullScreen />
        </a>
        <a
          id="splitViewBtn"
          href="#"
          onPointerEnter={() => void loadNewTabModal()}
          onFocus={() => void loadNewTabModal()}
          onClick={handleSplitView}
          class={`${splitBtnActive ? "active" : ""} ${splitBtnDisabled ? "disabled" : ""}`}
          aria-disabled={splitBtnDisabled}
        >
          <IconSplit />
        </a>
        <a
          id="erudaBtn"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            toggleEruda();
          }}
        >
          <IconCode />
        </a>
      </div>
    </div>
  );
}
