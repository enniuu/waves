import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import {
  IconSettingsSliderHor,
  IconColorPalette,
  IconPaintBrush,
  IconGhost,
  IconHeart,
  IconPuzzle,
  IconSushi,
  IconCrossMedium,
  IconChevronBottom,
  IconHammer2,
} from "../icons";
import type { IconProps } from "../icons/IconBase";
import { useManagedModal } from "../../core/ui/modal.ts";
import { toast } from "../../core/ui/toast.ts";
import { SEARCH_ENGINE_OPTIONS } from "../../core/config/config.ts";
import {
  ADVANCED_SETTING_KEYS,
  MOTION_OPTIONS,
  applyMotionPreference,
  readAdvancedToggle,
  readMotionPreference,
  type MotionPreference,
} from "../../core/config/advancedSettings.ts";
import { warmProxyRuntime } from "../../core/proxy/proxyRuntime.ts";
import { getRivet } from "../../core/proxy/rivetBridge.ts";
import { NEGATIVE } from "../../core/runtime/messages.ts";
import type { InstalledExtensionSummary } from "../../../packages/rivet/src/index";
import { HISTORY_STORAGE_KEY } from "../../core/browser/history.ts";
import "../../assets/styles/settings/settings-modal.css";
import {
  ANIME_QUALITY_KEY,
  ANIME_QUALITY_OPTIONS,
  ANIME_SETTING_KEYS,
  readAnimeQuality,
  readAnimeSetting,
  type AnimeQuality,
} from "../../core/media/animeSettings.ts";
import {
  DEFAULT_SETTINGS,
  GAME_SOURCE_OPTIONS,
  LINK_CLOAKING_OPTIONS,
  SITE_CLOAKING_OPTIONS,
  THEME_OPTIONS,
  TRANSPORT_OPTIONS,
  resolveTheme,
  resolveGameSource,
} from "../../core/config/settingsOptions.ts";

const iconMap: Record<
  string,
  (props: IconProps) => any
> = {
  IconSettingsSliderHor,
  IconColorPalette,
  IconPaintBrush,
  IconSushi,
  IconGhost,
  IconHammer2,
  IconPuzzle,
  IconHeart,
};

const SETTINGS_TABS: readonly {
  id: string;
  icon: string;
  label: string;
}[] = [
  { id: "preferences", icon: "IconSettingsSliderHor", label: "preferences" },
  { id: "appearance", icon: "IconPaintBrush", label: "appearance" },
  { id: "anime", icon: "IconSushi", label: "anime" },
  { id: "cloaking", icon: "IconGhost", label: "cloaking" },
  { id: "extensions", icon: "IconPuzzle", label: "extensions" },
  { id: "advanced", icon: "IconHammer2", label: "advanced" },
  { id: "about", icon: "IconHeart", label: "credits" },
] as const;

interface SelectorProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  isOpen: string | null;
  onOpen: (label: string) => void;
  onClose: () => void;
}

function Selector({
  label,
  value,
  options,
  onChange,
  isOpen,
  onOpen,
  onClose,
}: SelectorProps) {
  const open = isOpen === label;
  const ref = useRef<HTMLDivElement>(null);
  const availableOptions = useMemo(
    () => options.filter((o) => o !== value),
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [open, onClose]);

  return (
    <div class={`settings-selector ${label}-selector`} ref={ref}>
      <div
        class={`settings-selector-selected ${label}-selected${
          open ? ` settings-selector-open ${label}-arrow-active` : ""
        }`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          if (open) {
            onClose();
          } else {
            onOpen(label);
          }
        }}
      >
        <span>{value}</span>
        <IconChevronBottom size={16} class="selector-chevron" />
      </div>
      <div
        class={`settings-selector-options ${label}-options${
          open ? ` settings-selector-show ${label}-show` : ""
        }`}
        aria-hidden={!open}
      >
        {availableOptions.map((opt) => (
          <div
            key={opt}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onChange(opt);
              onClose();
            }}
          >
            {opt}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ id, checked, onChange }: ToggleProps) {
  const onToggle = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const isChecked = el.checked;
    el.classList.remove("animate-on", "animate-off");
    requestAnimationFrame(() => {
      el.classList.add(isChecked ? "animate-on" : "animate-off");
    });
    onChange(isChecked);
  };

  return (
    <input type="checkbox" id={id} checked={checked} onChange={onToggle} />
  );
}

export default function SettingsModal({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(openOnMount);
  const [isClosing, setIsClosing] = useState(false);
  const [activeTab, setActiveTab] = useState("preferences");
  const [openSelector, setOpenSelector] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const themeTransitionVersion = useRef(0);

  const [transport, setTransport] = useState(
    () => localStorage.getItem("transport") || DEFAULT_SETTINGS.transport,
  );
  const [searchEngine, setSearchEngine] = useState(
    () => localStorage.getItem("searchEngine") || DEFAULT_SETTINGS.searchEngine,
  );
  const [gameSource, setGameSource] = useState<string>(
    () => resolveGameSource(localStorage.getItem("gameSource")),
  );
  const [theme, setTheme] = useState<string>(
    () => resolveTheme(localStorage.getItem("theme")),
  );
  const [siteCloaking, setSiteCloaking] = useState(() => {
    const storedValue =
      localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking;
    return storedValue === "default" ? DEFAULT_SETTINGS.siteCloaking : storedValue;
  });
  const [linkCloaking, setLinkCloaking] = useState(
    () => localStorage.getItem("linkCloaking") || DEFAULT_SETTINGS.linkCloaking,
  );
  const [preventClosing, setPreventClosing] = useState(
    () => localStorage.getItem("preventClosing") !== "false",
  );
  const [focusCloaking, setFocusCloaking] = useState(
    () => localStorage.getItem("focusCloaking") !== "false",
  );
  const [saveHistory, setSaveHistory] = useState(() =>
    readAdvancedToggle("saveHistory"),
  );
  const [preloadProxy, setPreloadProxy] = useState(() =>
    readAdvancedToggle("preloadProxy"),
  );
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(
    () => readMotionPreference(),
  );
  const [autoPlayNextEpisode, setAutoPlayNextEpisode] = useState(() =>
    readAnimeSetting("autoPlayNextEpisode"),
  );
  const [autoSkipIntroOutro, setAutoSkipIntroOutro] = useState(() =>
    readAnimeSetting("autoSkipIntroOutro"),
  );
  const [animeQuality, setAnimeQuality] = useState<AnimeQuality>(() =>
    readAnimeQuality(),
  );
  const [versionInfo, setVersionInfo] = useState("");
  const [extensions, setExtensions] = useState<InstalledExtensionSummary[]>([]);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const closeSelector = useCallback(() => setOpenSelector(null), []);

  useEffect(() => {
    const appWindow = window as Record<string, any>;
    if (!appWindow.__lyraStuffData) {
      appWindow.__lyraStuffData = fetch("/api/stuff", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }
    appWindow.__lyraStuffData.then((serviceMetadata: any) => {
      if (serviceMetadata && typeof serviceMetadata.version === "string") {
        const build =
          typeof serviceMetadata.build === "string" ? `~${serviceMetadata.build}` : "";
        setVersionInfo(`v${serviceMetadata.version}${build}`);
      }
    });
  }, []);

  const finishClose = useCallback(() => {
    setIsOpen(false);
    setIsClosing(false);
  }, []);

  const requestClose = useCallback(() => {
    if (!isOpen || isClosing) return;
    setIsClosing(true);
  }, [isOpen, isClosing]);

  useEffect(() => {
    if (!isOpen || activeTab !== "extensions") return;
    warmProxyRuntime();
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const rivet = getRivet();
      if (!rivet) return;
      setExtensions(rivet.getInstalledExtensions());
      unsubscribe ??= rivet.onChange(refresh);
    };
    refresh();
    window.addEventListener("rivet-ready", refresh);
    return () => {
      window.removeEventListener("rivet-ready", refresh);
      unsubscribe?.();
    };
  }, [isOpen, activeTab]);

  const installExtensionFile = async (file: File) => {
    const rivet = getRivet();
    if (!rivet) {
      toast.error("rivet is still connecting");
      return;
    }
    setExtensionBusy(true);
    try {
      await rivet.installExtension(await file.arrayBuffer(), file.name);
      toast.success("extension installed");
      setExtensions(rivet.getInstalledExtensions());
    } catch (error) {
      console.error("extension install failed:", error, NEGATIVE);
      toast.error("extension install failed");
    } finally {
      setExtensionBusy(false);
    }
  };

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible: isOpen,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: finishClose,
  });

  const toggleSettingsModal = useCallback(() => {
    if (isOpen) {
      requestClose();
    } else {
      setIsClosing(false);
      setIsOpen(true);
    }
  }, [isOpen, requestClose]);

  useEffect(() => {
    window.toggleSettingsModal = toggleSettingsModal;
    return () => {
      delete window.toggleSettingsModal;
    };
  }, [toggleSettingsModal]);

  useEffect(() => {
    const icon = document.querySelector("#settings .settings");
    if (icon) {
      icon.classList.toggle("active-icon", isOpen && !isClosing);
    }
  }, [isOpen, isClosing]);

  const save = (key: string, value: string) => {
    localStorage.setItem(key, value);
    toast.success("settings saved");
  };

  const handleSetting = (
    key: string,
    value: string,
    setter: (v: string) => void,
  ) => {
    setter(value);
    save(key, value);

    if (key === "theme") {
      const applyTheme = () => {
        if (value === "default")
          document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", value);
      };

      if (!document.startViewTransition) {
        applyTheme();
      } else {
        const transitionVersion = ++themeTransitionVersion.current;
        document.documentElement.classList.add("theme-transitioning");
        const transition = document.startViewTransition(() => {
          applyTheme();
        });
        const cleanup = () => {
          if (themeTransitionVersion.current === transitionVersion) {
            document.documentElement.classList.remove("theme-transitioning");
          }
        };
        transition.finished.then(cleanup, cleanup);
      }
    } else if (key === "gameSource") {
      document.dispatchEvent(
        new CustomEvent("gameSourceUpdated", { detail: value }),
      );
    } else if (key === "transport") {
      document.dispatchEvent(
        new CustomEvent("newTransport", { detail: value }),
      );
    } else if (key === "siteCloaking") {
      document.dispatchEvent(
        new CustomEvent("siteCloakingUpdated", { detail: value }),
      );
    } else if (key === "linkCloaking") {
      const siteCloakName =
        localStorage.getItem("siteCloaking") || DEFAULT_SETTINGS.siteCloaking;
      document.dispatchEvent(
        new CustomEvent("linkCloakingUpdated", {
          detail: { linkCloaking: value, siteCloaking: siteCloakName },
        }),
      );
    } else if (key === ANIME_QUALITY_KEY) {
      document.dispatchEvent(
        new CustomEvent("animeSettingUpdated", {
          detail: { key, value },
        }),
      );
    } else if (key === ADVANCED_SETTING_KEYS.motion) {
      applyMotionPreference(value as MotionPreference);
      document.dispatchEvent(new CustomEvent("motionPreferenceUpdated"));
    }
  };

  const handleToggle = (
    key: string,
    value: boolean,
    setter: (v: boolean) => void,
  ) => {
    setter(value);
    save(key, String(value));

    if (key === "focusCloaking") {
      document.dispatchEvent(
        new CustomEvent("focusCloakingUpdated", { detail: value }),
      );
    } else if (
      key === ANIME_SETTING_KEYS.autoPlayNextEpisode ||
      key === ANIME_SETTING_KEYS.autoSkipIntroOutro
    ) {
      document.dispatchEvent(
        new CustomEvent("animeSettingUpdated", {
          detail: { key, value },
        }),
      );
    } else if (key === ADVANCED_SETTING_KEYS.saveHistory && !value) {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
    } else if (key === ADVANCED_SETTING_KEYS.preloadProxy && value) {
      warmProxyRuntime();
    }
  };

  if (!isOpen) return null;

  const modalClass = `settings-modal ${modalStateClass}${isClosing ? " close" : ""}${!isClosing ? " open" : ""}`;

  return (
    <div
      id="settings-modal"
      class={modalClass}
      ref={modalRef}
      onAnimationEnd={onAnimationEnd}
    >
      <h2>settings</h2>
      <div class="settings-container">
        <div class="settings-tabs">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              class={`tab-button${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {(() => {
                const IconComp = iconMap[t.icon];
                if (!IconComp) return null;
                return <IconComp />;
              })()}{" "}
              {t.label}
            </button>
          ))}
          <div class="settings-bottom">{versionInfo || "≽^•⩊•^≼"}</div>
        </div>
        <div class="settings-content-wrapper">
          {activeTab === "preferences" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>search engine</label>
              <p>the engine that is used for your search queries.</p>
              <Selector
                label="search-engine"
                value={searchEngine}
                options={SEARCH_ENGINE_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("searchEngine", v, setSearchEngine)
                }
              />
            </div>
            <div class="settings-item">
              <label>game source</label>
              <p>where all the games are fetched from.</p>
              <Selector
                label="game-source"
                value={gameSource}
                options={GAME_SOURCE_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("gameSource", v, setGameSource)}
              />
            </div>
            <div class="settings-item">
              <label>prevent closing</label>
              <p>prevent the tab from being closed.</p>
              <Toggle
                id="prevent-closing-toggle"
                checked={preventClosing}
                onChange={(v) =>
                  handleToggle("preventClosing", v, setPreventClosing)
                }
              />
            </div>
          </div>
          )}

          {activeTab === "anime" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>preferred quality</label>
              <p>choose the quality used when an anime starts.</p>
              <Selector
                label="anime-quality"
                value={animeQuality}
                options={ANIME_QUALITY_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(value) =>
                  handleSetting(
                    ANIME_QUALITY_KEY,
                    value,
                    (next) => setAnimeQuality(next as AnimeQuality),
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>auto play next episode</label>
              <p>
                automatically start the next episode.
              </p>
              <Toggle
                id="anime-auto-play-next-episode-toggle"
                checked={autoPlayNextEpisode}
                onChange={(value) =>
                  handleToggle(
                    ANIME_SETTING_KEYS.autoPlayNextEpisode,
                    value,
                    setAutoPlayNextEpisode,
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>auto skip intro and outro</label>
              <p>
                auto skip intro and outro when
                available.
              </p>
              <Toggle
                id="anime-auto-skip-intro-outro-toggle"
                checked={autoSkipIntroOutro}
                onChange={(value) =>
                  handleToggle(
                    ANIME_SETTING_KEYS.autoSkipIntroOutro,
                    value,
                    setAutoSkipIntroOutro,
                  )
                }
              />
            </div>
          </div>
          )}

          {activeTab === "appearance" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>theme</label>
              <p>change the look and feel of lyra.</p>
              <Selector
                label="theme"
                value={theme}
                options={THEME_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("theme", v, setTheme)}
              />
            </div>
            <div class="settings-item">
              <label>motion effects</label>
              <p>
                follow the device setting, reduce motion, or allow full effects.
              </p>
              <Selector
                label="motion-preference"
                value={motionPreference}
                options={MOTION_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(value) =>
                  handleSetting(
                    ADVANCED_SETTING_KEYS.motion,
                    value,
                    (next) => setMotionPreference(next as MotionPreference),
                  )
                }
              />
            </div>
          </div>
          )}

          {activeTab === "cloaking" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>site cloaking</label>
              <p>cloak the site title and favicon as a different site.</p>
              <Selector
                label="site-cloaking"
                value={siteCloaking}
                options={SITE_CLOAKING_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("siteCloaking", v, setSiteCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>link cloaking</label>
              <p>cloak the site link in the url bar.</p>
              <Selector
                label="link-cloaking"
                value={linkCloaking}
                options={LINK_CLOAKING_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) =>
                  handleSetting("linkCloaking", v, setLinkCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>focus cloaking</label>
              <p>cloak the title and favicon when clicking off the tab.</p>
              <Toggle
                id="focus-cloaking-toggle"
                checked={focusCloaking}
                onChange={(v) =>
                  handleToggle("focusCloaking", v, setFocusCloaking)
                }
              />
            </div>
          </div>
          )}

          {activeTab === "advanced" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>other transport</label>
              <p>
                our transport handles http requests; this handles websockets and
                fallback traffic.
              </p>
              <Selector
                label="transport"
                value={transport}
                options={TRANSPORT_OPTIONS}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={closeSelector}
                onChange={(v) => handleSetting("transport", v, setTransport)}
              />
            </div>
            <div class="settings-item">
              <label>preload engine</label>
              <p>
                load the browser engine early so the first page opens faster.
              </p>
              <Toggle
                id="preload-proxy-toggle"
                checked={preloadProxy}
                onChange={(value) =>
                  handleToggle(
                    ADVANCED_SETTING_KEYS.preloadProxy,
                    value,
                    setPreloadProxy,
                  )
                }
              />
            </div>
            <div class="settings-item">
              <label>save browsing history</label>
              <p>
                keep visited urls between launches; turning this off removes
                saved history.
              </p>
              <Toggle
                id="save-history-toggle"
                checked={saveHistory}
                onChange={(value) =>
                  handleToggle(
                    ADVANCED_SETTING_KEYS.saveHistory,
                    value,
                    setSaveHistory,
                  )
                }
              />
            </div>
          </div>
          )}

          {activeTab === "extensions" && (
          <div class="tab-content active">
            <div class="settings-item rivet-manager-header">
                <label>extensions</label>
                <p>install chrome extensions into the browser.</p>
              <div class="rivet-manager-actions">
                <label class="rivet-file-button rivet-action-primary">
                  {extensionBusy ? "working…" : "upload extension"}
                  <input
                    type="file"
                    accept=".zip,.crx,application/zip"
                    disabled={extensionBusy}
                    onChange={(event) => {
                      const input = event.currentTarget as HTMLInputElement;
                      const file = input.files?.[0];
                      if (file) void installExtensionFile(file);
                      input.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
            {extensions.length === 0 ? (
              <div class="settings-item">
                <p>no extensions installed.</p>
              </div>
            ) : (
              extensions.map((extension) => (
                <div class="settings-item rivet-extension" key={extension.id}>
                  <div class="rivet-extension-copy">
                    {extension.iconUrl ? (
                      <img src={extension.iconUrl} alt="" />
                    ) : null}
                    <div>
                      <label>{extension.name}</label>
                      <p>
                        {extension.version || "unknown version"} ·{" "}
                        {extension.id}
                      </p>
                    </div>
                  </div>
                  <div class="rivet-manager-actions">
                    {extension.hasPopup ? (
                      <button
                        type="button"
                        class="rivet-action-secondary"
                        onClick={() => {
                          const rivet = getRivet();
                          const page = rivet?.getExtensionPopupPage(
                            extension.id,
                          );
                          if (page && rivet) {
                            rivet.host.openExtensionTab?.(
                              extension.id,
                              page,
                              null,
                            );
                          }
                        }}
                      >
                        open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      class="rivet-action-secondary"
                      onClick={() =>
                        void getRivet()?.setExtensionEnabled(
                          extension.id,
                          !extension.enabled,
                        )
                      }
                    >
                      {extension.enabled ? "disable" : "enable"}
                    </button>
                    <button
                      type="button"
                      class="rivet-action-secondary"
                      onClick={() =>
                        void getRivet()?.uninstallExtension(extension.id)
                      }
                    >
                      uninstall
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          )}

          {activeTab === "about" && (
          <div class="tab-content active">
            <div class="settings-item">
              <label>credits</label>
              <p>selenite - game source</p>
              <p>edurocks - game source</p>
              <p>gn-math - game source</p>
              <p>wasm.rip - game source</p>
              <p>velara - game source</p>
              <p>truffled - game source</p>
              <p>mercury workshop - scramjet, epoxy, and libcurl</p>
            </div>
            <div class="settings-item">
              <label>thats it bye bye!! (˵◝ ⩊  ◜˵マ</label>
            </div>
          </div>
          )}
        </div>
      </div>
      <button
        id="close-settings-modal"
        class="modal-close-btn"
        onClick={toggleSettingsModal}
      >
        <IconCrossMedium />
      </button>
    </div>
  );
}
