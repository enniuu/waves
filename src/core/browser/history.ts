import { readAdvancedToggle } from "../config/advancedSettings.ts";

export interface HistoryState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface HistoryManagerOptions {
  onUpdate?: (state: HistoryState) => void;
}

interface PersistedHistoryEntry {
  url: string;
  visitedAt: number;
}

interface PersistedHistory {
  version: 1;
  entries: PersistedHistoryEntry[];
}

export const HISTORY_STORAGE_KEY = "lyra-history-v1";
const HISTORY_VERSION = 1 as const;
const MAX_PERSISTED_ENTRIES = 500;

function readPersistedHistory(): PersistedHistory {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "null");
    if (
      parsed?.version !== HISTORY_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      return { version: HISTORY_VERSION, entries: [] };
    }
    const entries = parsed.entries.filter(
      (entry: unknown): entry is PersistedHistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PersistedHistoryEntry).url === "string" &&
        Number.isFinite((entry as PersistedHistoryEntry).visitedAt),
    );
    return {
      version: HISTORY_VERSION,
      entries: entries.slice(-MAX_PERSISTED_ENTRIES),
    };
  } catch {
    return { version: HISTORY_VERSION, entries: [] };
  }
}

function persistVisit(url: string): void {
  if (!readAdvancedToggle("saveHistory")) return;
  try {
    const history = readPersistedHistory();
    const entry = { url, visitedAt: Date.now() };
    history.entries.push(entry);
    history.entries = history.entries.slice(-MAX_PERSISTED_ENTRIES);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    
  }
}

export class HistoryManager {
  #stack: { url: string; key?: string }[] = [];
  #currentIndex: number = -1;
  #pending: "push" | "replace" | null = null;
  #onUpdateCallback: (state: HistoryState) => void;
  static readonly #MAX_ENTRIES = 150;

  constructor({ onUpdate = () => {} }: HistoryManagerOptions = {}) {
    this.#onUpdateCallback = onUpdate;
  }

  #notify(): void {
    this.#onUpdateCallback({
      currentUrl: this.getCurrentUrl(),
      canGoBack: this.canGoBack(),
      canGoForward: this.canGoForward(),
    });
  }

  begin(mode: "push" | "replace" = "push"): void {
    this.#pending = mode;
  }

  cancel(): void {
    this.#pending = null;
  }

  // Entry keys distinguish visits even when their URLs are identical.
  observe(url: string, type = "metadata", key?: string): void {
    if (!url || url === "about:blank") return;
    const pending = this.#pending;
    this.#pending = null;
    const index = key
      ? this.#stack[this.#currentIndex]?.key === key
        ? this.#currentIndex
        : this.#stack.findIndex((entry) => entry.key === key)
      : -1;
    if (index !== -1) {
      const changed = this.#currentIndex !== index || this.getCurrentUrl() !== url;
      if (this.#stack[index]!.url !== url) persistVisit(url);
      this.#currentIndex = index;
      this.#stack[index]!.url = url;
      if (changed) this.#notify();
      return;
    }
    if (pending === "replace" || type === "replace" || type === "reload" || type === "history-replace") {
      this.replace(url, key);
    } else if (!key && (type === "popstate" || type === "traverse")) {
      const target = this.#stack.findLastIndex((entry) => entry.url === url);
      if (target !== -1) {
        this.#currentIndex = target;
        this.#notify();
      } else this.replace(url);
    } else if (key || type === "push" || type === "history-push" || this.getCurrentUrl() !== url) {
      this.push(url, key);
    }
  }

  push(url: string, key?: string): void {
    if (!url || url === "about:blank") return;

    if (this.#currentIndex < this.#stack.length - 1) {
      this.#stack.length = this.#currentIndex + 1;
    }
    this.#stack.push({ url, ...(key ? { key } : {}) });
    this.#currentIndex++;
    if (this.#stack.length > HistoryManager.#MAX_ENTRIES) {
      const overflow = this.#stack.length - HistoryManager.#MAX_ENTRIES;
      this.#stack.splice(0, overflow);
      this.#currentIndex = Math.max(0, this.#currentIndex - overflow);
    }
    persistVisit(url);
    this.#notify();
  }

  replace(url: string, key?: string): void {
    if (!url || url === "about:blank") return;
    if (this.#currentIndex < 0) return this.push(url, key);
    const current = this.#stack[this.#currentIndex]!;
    if (current.url === url && (!key || current.key === key)) return;

    this.#stack[this.#currentIndex] = { url, ...(key ? { key } : {}) };
    if (current.url !== url) persistVisit(url);
    this.#notify();
  }

  back(): string | null {
    if (this.canGoBack()) {
      this.#currentIndex--;
      this.#notify();
      return this.getCurrentUrl();
    }
    return null;
  }

  forward(): string | null {
    if (this.canGoForward()) {
      this.#currentIndex++;
      this.#notify();
      return this.getCurrentUrl();
    }
    return null;
  }

  getCurrentUrl(): string | null {
    return this.#stack[this.#currentIndex]?.url ?? null;
  }

  getTarget(delta: -1 | 1): { url: string; key?: string } | null {
    return this.#stack[this.#currentIndex + delta] ?? null;
  }

  canGoBack(): boolean {
    return this.#currentIndex > 0;
  }

  canGoForward(): boolean {
    return this.#currentIndex < this.#stack.length - 1;
  }

  destroy(): void {
    this.#stack = [];
    this.#currentIndex = -1;
    this.#pending = null;
    this.#onUpdateCallback = () => {};
  }
}
