export const loadGamesCatalog = () =>
  import("../components/games/GamesCatalog.tsx");

export const loadAnimeCatalog = () =>
  import("../components/anime/AnimeCatalog.tsx");

export function preloadGamesCatalog() {
  void loadGamesCatalog().catch(() => {});
  void import("../features/games/games.ts")
    .then(({ fetchGameData }) => fetchGameData())
    .catch(() => {});
}

export function preloadAnimeCatalog() {
  void loadAnimeCatalog().catch(() => {});
  void import("../features/anime/anime.ts")
    .then(({ fetchAnimeData }) => fetchAnimeData("anime"))
    .catch(() => {});
}

export const loadNewTabModal = () =>
  import("../components/browser/NewTabModal.tsx");

export const loadSettingsModal = () =>
  import("../components/settings/SettingsModal.tsx");

export const loadCloudSync = () =>
  Promise.all([
    import("../assets/styles/cloudsync/cloudsync-modal.css"),
    import("../features/cloudsync/cloudsync.ts"),
  ]).then(() => undefined);
