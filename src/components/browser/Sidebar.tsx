import { useState, useMemo, useCallback } from "preact/hooks";
import { memo } from "preact/compat";
import { store, useStore } from "../../state/store.ts";
import { sidebarHiddenSignal } from "../../core/ui/uiSignals";
import { IconCrossMedium, IconPlusMedium } from "../icons";
import {
  getSidebarFooterStatus,
  getSidebarFooterText,
} from "./sidebarStatus.ts";
import { loadNewTabModal } from "../../app/loaders.ts";
import { svgIcon } from "../../core/ui/svgIcon";

const DEFAULT_FAVICON =
  `data:image/svg+xml,${encodeURIComponent(
    svgIcon("IconGlobe", { size: 18, style: "color:#818181" }),
  )}`;

function TabIcon({ favicon, eager }: { favicon: string | null | undefined; eager: boolean | undefined }) {
  return <TabIconInner key={favicon || "default"} favicon={favicon} eager={eager} />;
}

function TabIconInner({ favicon, eager }: { favicon: string | null | undefined; eager: boolean | undefined }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src = favicon || DEFAULT_FAVICON;

  return (
    <div class={`tab-icon${!loaded && !errored ? " skeleton" : ""}`}>
      <img
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        src={errored ? DEFAULT_FAVICON : src}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(true);
          setErrored(true);
        }}
      />
    </div>
  );
}

const Tab = memo(function Tab({
  id,
  title,
  favicon,
  isLoading,
  isActive,
  isSplitPair,
  splitSide,
}: {
  id: number;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  isActive: boolean;
  isSplitPair: boolean;
  splitSide: string | null;
}) {
  const classes = ["tab"];
  if (isActive) classes.push("active");
  if (isSplitPair) {
    classes.push("split-pair");
    if (splitSide === "left")
      classes.push("split-pair-left", "split-active-left");
    if (splitSide === "right")
      classes.push("split-pair-right", "split-active-right");
  }

  const onTabClick = useCallback(
    (e: MouseEvent) => {
      if (e.target && (e.target as HTMLElement).closest(".tab-close")) return;
      store.switchTab(id);
    },
    [id],
  );

  const onCloseClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      store.closeTab(id);
    },
    [id],
  );

  return (
    <div
      class={classes.join(" ")}
      data-tab-id={id}
      onClick={onTabClick}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          store.closeTab(id);
        }
      }}
    >
      <TabIcon favicon={favicon} eager={isActive} />
      <span class="tab-title">
        {isLoading && title === "new tab"
          ? "fetching data..."
          : title}
      </span>
      <button
        class="tab-close"
        aria-label="close tab"
        onClick={onCloseClick}
      >
        <IconCrossMedium />
      </button>
    </div>
  );
});

export default function Sidebar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair);
  const activeTab = useStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId),
  );
  const isSplitPairDefined =
    splitPair.left !== null && splitPair.right !== null;
  const isSplitLayout = isSplitPairDefined &&
    (activeTabId === splitPair.left || activeTabId === splitPair.right);
  const playerStatus = activeTab?.playerStatus || "idle";
  const pageLoading = activeTab?.isLoading === true;
  const footerStatus = getSidebarFooterStatus(playerStatus, pageLoading);
  const footerIsLoading = [
    "loading",
    "buffering",
    "waiting",
    "stalled",
  ].includes(footerStatus);
  const footerText = getSidebarFooterText(playerStatus, pageLoading);
  const footerClasses = [
    "sidebar-footer",
    footerStatus !== "idle" ? "has-status" : "",
    footerIsLoading ? "loading" : "",
    footerStatus ? `status-${footerStatus}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const tabViewModels = useMemo(() => {
    return tabs.map((tab) => {
      let isActive = false;
      let isSplitPairTab = false;
      let splitSide = null;

      if (
        isSplitPairDefined &&
        (tab.id === splitPair.left || tab.id === splitPair.right)
      ) {
        isSplitPairTab = true;
        splitSide = tab.id === splitPair.left ? "left" : "right";
      }

      if (isSplitLayout) {
        isActive = tab.id === splitPair.left || tab.id === splitPair.right;
      } else {
        isActive = tab.id === activeTabId;
      }

      return {
        tab,
        isActive,
        isSplitPair: isSplitPairTab,
        splitSide,
      };
    });
  }, [
    tabs,
    isSplitLayout,
    isSplitPairDefined,
    splitPair.left,
    splitPair.right,
    activeTabId,
  ]);

  const openNewTabModal = useCallback(() => {
    (window as any).showNewTabModal?.();
  }, []);

  return (
    <nav class="sidebar">
      <div class="tabs-header">
        <span>tabs</span>
      </div>
      <button
        id="add-tab-btn"
        onPointerEnter={() => void loadNewTabModal()}
        onFocus={() => void loadNewTabModal()}
        onClick={openNewTabModal}
        aria-pressed={sidebarHiddenSignal}
      >
        <IconPlusMedium /> new tab
      </button>
      <div id="tabs-container" class="tabs-container">
        {tabViewModels.map(({ tab, isActive, isSplitPair, splitSide }) => {
          return (
            <Tab
              key={tab.id}
              id={tab.id}
              title={tab.title}
              favicon={tab.favicon}
              isLoading={tab.isLoading}
              isActive={isActive}
              isSplitPair={isSplitPair}
              splitSide={splitSide}
            />
          );
        })}
      </div>
      <div id="sidebar-footer" class={footerClasses}>
        <div class="sidebar-footer-oneko"></div>
        <span class="sidebar-footer-text">{footerText}</span>
      </div>
    </nav>
  );
}
