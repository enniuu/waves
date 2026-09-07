import {
  useEffect,
  lazy,
  Suspense,
  useState,
} from "preact/compat";
import Sidebar from "../components/browser/Sidebar.tsx";
import NavBar from "../components/browser/NavBar.tsx";
import SearchBar from "../components/browser/SearchBar.tsx";
import Bookmarks from "../components/browser/Bookmarks.tsx";
import Footer from "../components/layout/Footer.tsx";
import TopBar from "../components/browser/TopBar.tsx";
import hachiiUrl from "../assets/images/peaks/hachii.webp";
import konaUrl from "../assets/images/peaks/kona.webp";
import osaUrl from "../assets/images/peaks/osa.webp";
import azuUrl from "../assets/images/peaks/azu.webp";
import {
  loadAnimeCatalog,
  loadGamesCatalog,
  loadNewTabModal,
  loadSettingsModal,
} from "./loaders.ts";

const peakUrls = [hachiiUrl, konaUrl, osaUrl, azuUrl];
const PEAK_INDEX_STORAGE_KEY = "lyra-title-peak-index";

function getRandomPeakIndex(): number {
  const preloadedIndex = Number(document.documentElement.dataset.peakIndex);
  if (
    Number.isInteger(preloadedIndex) &&
    preloadedIndex >= 0 &&
    preloadedIndex < peakUrls.length
  ) {
    return preloadedIndex;
  }

  let previousIndex = -1;
  try {
    const storedIndex = localStorage.getItem(PEAK_INDEX_STORAGE_KEY);
    if (storedIndex !== null) previousIndex = Number(storedIndex);
  } catch {}

  let nextIndex = Math.floor(Math.random() * peakUrls.length);
  if (peakUrls.length > 1 && nextIndex === previousIndex) {
    nextIndex =
      (nextIndex + 1 + Math.floor(Math.random() * (peakUrls.length - 1))) %
      peakUrls.length;
  }

  try {
    localStorage.setItem(PEAK_INDEX_STORAGE_KEY, String(nextIndex));
  } catch {}
  return nextIndex;
}

const GamesCatalog = lazy(loadGamesCatalog);
const AnimeCatalog = lazy(loadAnimeCatalog);
const NewTabModal = lazy(loadNewTabModal);
const SettingsModal = lazy(loadSettingsModal);

export default function App() {
  const [gamesMounted, setGamesMounted] = useState(false);
  const [animeMounted, setAnimeMounted] = useState(false);
  const [newTabMounted, setNewTabMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [peakIndex] = useState(getRandomPeakIndex);

  useEffect(() => {
    const showGames = () => setGamesMounted(true);
    const showAnime = () => setAnimeMounted(true);
    const showNewTab = () => {
      setNewTabMounted(true);
    };
    const showSettings = () => {
      setSettingsMounted(true);
    };
    const runtimeWindow = window as typeof window & {
      showNewTabModal?: () => void;
    };

    window.showGameMenu = showGames;
    window.toggleGameMenu = showGames;
    window.showAnimeMenu = showAnime;
    window.toggleAnimeMenu = showAnime;
    runtimeWindow.showNewTabModal = showNewTab;
    window.toggleSettingsModal = showSettings;

    return () => {
      if (window.showGameMenu === showGames) delete window.showGameMenu;
      if (window.toggleGameMenu === showGames) delete window.toggleGameMenu;
      if (window.showAnimeMenu === showAnime) delete window.showAnimeMenu;
      if (window.toggleAnimeMenu === showAnime) delete window.toggleAnimeMenu;
      if (runtimeWindow.showNewTabModal === showNewTab) {
        delete runtimeWindow.showNewTabModal;
      }
      if (window.toggleSettingsModal === showSettings) {
        delete window.toggleSettingsModal;
      }
    };
  }, []);

  return (
    <>
      <TopBar />
      <Sidebar />
      <div class="content-area">
        <NavBar />
        <div class="main-container">
          <div class="title">
            <img
              src={peakUrls[peakIndex]}
              alt=""
              width="85"
              height="90"
              loading="eager"
              decoding="async"
              fetchpriority="high"
              draggable={false}
            />
          </div>
          <SearchBar />
        </div>
        <Bookmarks />
        {gamesMounted && (
          <Suspense fallback={null}>
            <GamesCatalog openOnMount />
          </Suspense>
        )}
        {animeMounted && (
          <Suspense fallback={null}>
            <AnimeCatalog openOnMount />
          </Suspense>
        )}
        <div id="iframe-container">
          <div id="iframe-resize-divider"></div>
        </div>
        <Footer />
      </div>
      {newTabMounted && (
        <Suspense fallback={null}>
          <NewTabModal openOnMount />
        </Suspense>
      )}
      {settingsMounted && (
        <Suspense fallback={null}>
          <SettingsModal openOnMount />
        </Suspense>
      )}
      <div id="overlay" class="overlay" />
    </>
  );
}
