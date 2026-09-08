import {
  createRivetFramePlugins,
  initializeRivet,
} from "./rivet";
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import { MochiTransport, resolveMochiOrigin } from "./mochiTransport";
import { negativeMessage } from "../runtime/messages.ts";
import { runtimeAssetPath } from "../runtime/build.ts";

type FolioControllerInstance = {
  wait(): Promise<void>;
  setServiceWorker(serviceWorker: ServiceWorker): void;
  setTransport(transport: unknown): void;
  createFrame(
    iframe: HTMLIFrameElement,
    options?: { plugins?: unknown[] },
  ): FolioFrameInstance;
};

type FolioFrameInstance = {
  prefix: string;
  go(url: string): void;
  destroy?(): void;
};

type FolioPageState = {
  client?: {
    hooks?: {
      lifecycle?: {
        navigate?: unknown;
      };
    };
    url?: {
      href?: string;
    };
    id?: string;
  };
  isTopLevel?: boolean;
  window?: Window;
};

type FolioControllerConstructor = new (init: {
  serviceworker: ServiceWorker;
  transport: unknown;
  config: {
    prefix: string;
    folioPath: string;
    injectPath: string;
    wasmPath: string;
    virtualWasmPath: string;
    codec: {
      encode(input: string): string;
      decode(input: string): string;
    };
  };
  folioConfig?: unknown;
}) => FolioControllerInstance;

type FolioRuntimeGlobals = {
  defaultConfigDev?: unknown;
  defaultConfig?: unknown;
  prewarmRewriter?: () => boolean;
};

interface FolioGlobals {
  Controller?: FolioControllerConstructor;
  ManagedPlugin?: new (name: string, dependencies: string[]) => {
    install(frame: unknown): void;
    tap(hook: unknown, callback: (...args: any[]) => void | Promise<void>): void;
  };
}

const FOLIO_PREFIX = "/f/";
const MOCHI_RAW_PREFIX = "/!!raw/";
const MOCHI_ACCELERATOR_TIMEOUT_MS = 8000;
const FOLIO_HOT_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const FOLIO_HOT_CACHE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);
const MOCHI_ACCELERATED_DESTINATIONS = new Set([
  "audio",
  "font",
  "image",
  "style",
  "track",
  "video",
]);
const frameByIframe = new WeakMap<HTMLIFrameElement, FolioFrameInstance>();
const hotAssetCache = new Map<string, HotAssetEntry>();
const hotAssetPending = new Map<string, Promise<HotAssetEntry | null>>();
let hotAssetCacheBytes = 0;

let controller: FolioControllerInstance | null = null;
let readyPromise: Promise<FolioControllerInstance> | null = null;
let currentTransportKey = "";
let generalMochiTransportEnabled = false;

function getControllerConstructor(): FolioControllerConstructor {
  const globals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  if (!globals?.Controller) {
    throw new Error(negativeMessage("source-built folio controller is not loaded"));
  }
  return globals.Controller;
}

async function createTransport(name: string, wispUrl: string): Promise<ProxyTransport> {
  let fallback: ProxyTransport;
  if (name === "libcurl") {
    const transportPath = runtimeAssetPath("libcurl", "index.mjs");
    const mod = await import(/* @vite-ignore */ transportPath);
    const Transport = mod.default;
    fallback = new Transport({ wisp: wispUrl }) as ProxyTransport;
  } else {
    const transportPath = runtimeAssetPath("epoxy", "index.mjs");
    const mod = await import(/* @vite-ignore */ transportPath);
    const Transport = mod.default;
    fallback = new Transport({ wisp: wispUrl }) as ProxyTransport;
  }
  generalMochiTransportEnabled = true;
  return new MochiTransport(fallback);
}

function folioRuntimeConfig() {
  return {
    prefix: FOLIO_PREFIX,
    folioPath: "/b/fl/folio.js",
    injectPath: "/b/fl/controller.inject.js",
    wasmPath: "/b/fl/folio.wasm",
    virtualWasmPath: "folio.wasm.js",
    codec: {
      encode: (input: string) => (input ? encodeURIComponent(input) : input),
      decode: (input: string) => (input ? decodeURIComponent(input) : input),
    },
  };
}

type MochiRawMeta = {
  status: number;
  status_text?: string;
  statusText?: string;
  url?: string;
  raw_headers?: [string, string][];
  rawHeaders?: [string, string][];
};

type HotAssetEntry = {
  body: ArrayBuffer;
  expiresAt: number;
  rawHeaders: [string, string][];
  size: number;
  status: number;
  statusText: string;
  url?: string;
};

function mochiRawBase(): string {
  const globals = window as unknown as {
    __MOCHI_BASE__?: string;
    MOCHI_BASE?: string;
  };
  const configured = globals.__MOCHI_BASE__ || globals.MOCHI_BASE;
  if (configured && configured.startsWith("http")) {
    return (
      configured
        .replace(/\/+$/, "")
        .replace(/\/!!raw$/, "")
        .replace(/\/!!$/, "") + MOCHI_RAW_PREFIX
    );
  }
  return window.location.origin + MOCHI_RAW_PREFIX;
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    let input = value.replace(/-/g, "+").replace(/_/g, "/");
    while (input.length % 4) input += "=";
    const bytes = Uint8Array.from(atob(input), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function rawHeadersToHeaders(rawHeaders: [string, string][]): Headers {
  const headers = new Headers();
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === "set-cookie") continue;
    try {
      headers.append(key, value);
    } catch {}
  }
  return headers;
}

function hotAssetKey(method: string, target: URL): string {
  return `${method}\n${target.href}`;
}

function rawHeaderValue(
  rawHeaders: [string, string][],
  name: string,
): string | null {
  const lowerName = name.toLowerCase();
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

function hotCacheMaxAgeMs(rawHeaders: [string, string][]): number {
  const cacheControl = rawHeaderValue(rawHeaders, "cache-control");
  if (cacheControl) {
    const directives = cacheControl
      .split(",")
      .map((part) => part.trim().toLowerCase());
    if (directives.includes("no-store") || directives.includes("private")) {
      return 0;
    }
    for (const directive of directives) {
      const [name, value] = directive.split("=", 2);
      if (name === "max-age" || name === "s-maxage") {
        const seconds = Number.parseInt(value?.replace(/^"|"$/g, "") ?? "", 10);
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.min(seconds * 1000, 10 * 60 * 1000);
        }
      }
    }
    if (directives.includes("immutable")) return 10 * 60 * 1000;
  }

  const expires = rawHeaderValue(rawHeaders, "expires");
  if (expires) {
    const expiresAt = Date.parse(expires);
    if (Number.isFinite(expiresAt)) {
      return Math.max(0, Math.min(expiresAt - Date.now(), 10 * 60 * 1000));
    }
  }

  return 0;
}

function rememberHotAsset(key: string, entry: HotAssetEntry): void {
  const existing = hotAssetCache.get(key);
  if (existing) hotAssetCacheBytes -= existing.size;
  hotAssetCache.set(key, entry);
  hotAssetCacheBytes += entry.size;

  for (const [oldestKey, oldest] of hotAssetCache) {
    if (hotAssetCacheBytes <= FOLIO_HOT_CACHE_MAX_TOTAL_BYTES) break;
    hotAssetCache.delete(oldestKey);
    hotAssetCacheBytes -= oldest.size;
  }
}

function getHotAsset(key: string): HotAssetEntry | null {
  const entry = hotAssetCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    hotAssetCache.delete(key);
    hotAssetCacheBytes -= entry.size;
    return null;
  }
  hotAssetCache.delete(key);
  hotAssetCache.set(key, entry);
  return entry;
}

function hotAssetToBareResponse(entry: HotAssetEntry, BareResponse: any): any {
  const nativeResponse = new Response(entry.body.slice(0), {
    status: entry.status,
    statusText: entry.statusText,
    headers: rawHeadersToHeaders(entry.rawHeaders),
  });
  const bareResponse = BareResponse.fromNativeResponse(nativeResponse);
  bareResponse.rawHeaders = entry.rawHeaders;
  if (entry.url) bareResponse.url = entry.url;
  return bareResponse;
}

async function storeHotAsset(
  key: string,
  response: Response,
  meta: MochiRawMeta,
  rawHeaders: [string, string][],
): Promise<HotAssetEntry | null> {
  const maxAgeMs = hotCacheMaxAgeMs(rawHeaders);
  if (maxAgeMs <= 0 || meta.status !== 200 || BODYLESS_STATUS.has(meta.status)) {
    return null;
  }

  const contentLength = Number.parseInt(
    rawHeaderValue(rawHeaders, "content-length") ?? "",
    10,
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > FOLIO_HOT_CACHE_MAX_ENTRY_BYTES
  ) {
    return null;
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > FOLIO_HOT_CACHE_MAX_ENTRY_BYTES) return null;

  const entry: HotAssetEntry = {
    body,
    expiresAt: Date.now() + maxAgeMs,
    rawHeaders,
    size: body.byteLength,
    status: meta.status,
    statusText: meta.status_text ?? meta.statusText ?? "",
    ...(meta.url === undefined ? {} : { url: meta.url }),
  };
  rememberHotAsset(key, entry);
  return entry;
}

function createMochiAcceleratorPlugin(): unknown {
  
  
  
  if (generalMochiTransportEnabled) return null;
  const controllerGlobals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  const folioGlobals = (window as unknown as { $folio?: Record<string, any> })
    .$folio;
  const ManagedPlugin = controllerGlobals?.ManagedPlugin;
  const BareResponse = folioGlobals?.BareResponse;
  if (!ManagedPlugin || !BareResponse?.fromNativeResponse) return null;

  return new (class MochiAcceleratorPlugin extends ManagedPlugin {
    constructor() {
      super("mochi-accelerator", []);
    }

    override install(frame: any): void {
      super.install(frame);
      this.tap(frame.hooks.fetch.request, async (context: any, props: any) => {
        if (props.earlyResponse) return;
        const method = String(props.init?.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") return;
        if (!MOCHI_ACCELERATED_DESTINATIONS.has(context.parsed?.destination)) {
          return;
        }
        const target = props.url;
        if (!(target instanceof URL)) return;
        if (target.protocol !== "http:" && target.protocol !== "https:") return;
        const cacheKey = hotAssetKey(method, target);
        const hotEntry = getHotAsset(cacheKey);
        if (hotEntry) {
          props.earlyResponse = hotAssetToBareResponse(hotEntry, BareResponse);
          return;
        }

        const pendingHotEntry = hotAssetPending.get(cacheKey);
        if (pendingHotEntry) {
          const entry = await pendingHotEntry;
          if (entry && !props.earlyResponse) {
            props.earlyResponse = hotAssetToBareResponse(entry, BareResponse);
          }
          return;
        }

        const abort = new AbortController();
        const timeout = window.setTimeout(
          () => abort.abort(),
          MOCHI_ACCELERATOR_TIMEOUT_MS,
        );
        try {
          const headers = new Headers(props.init?.headers || []);
          headers.delete("host");
          const rawResponse = await fetch(
            mochiRawBase() + encodeURIComponent(target.href),
            {
              method,
              headers,
              cache: "no-store",
              credentials: "include",
              redirect: "manual",
              signal: abort.signal,
            },
          );
          const encodedMeta = rawResponse.headers.get("x-mochi-upstream-meta");
          if (!rawResponse.ok || !encodedMeta) return;

          const meta = decodeBase64UrlJson<MochiRawMeta>(encodedMeta);
          const rawHeaders = meta?.raw_headers ?? meta?.rawHeaders;
          if (
            !meta ||
            !Number.isInteger(meta.status) ||
            meta.status < 200 ||
            meta.status > 599 ||
            !Array.isArray(rawHeaders)
          ) {
            return;
          }
          if (props.earlyResponse) return;

          const cacheCopy = rawResponse.clone();
          const pending = storeHotAsset(
            cacheKey,
            cacheCopy,
            meta,
            rawHeaders,
          ).finally(() => {
            hotAssetPending.delete(cacheKey);
          });
          hotAssetPending.set(cacheKey, pending);

          const body = BODYLESS_STATUS.has(meta.status) ? null : rawResponse.body;
          const nativeResponse = new Response(body, {
            status: meta.status,
            statusText: meta.status_text ?? meta.statusText ?? "",
            headers: rawHeadersToHeaders(rawHeaders),
          });
          const bareResponse = BareResponse.fromNativeResponse(nativeResponse);
          bareResponse.rawHeaders = rawHeaders;
          if (typeof meta.url === "string") bareResponse.url = meta.url;
          props.earlyResponse = bareResponse;
        } catch {
          return;
        } finally {
          window.clearTimeout(timeout);
        }
      });
    }
  })();
}

function createFolioHttpCachePlugin(): unknown {
  const folioUtils = (window as unknown as {
    $folioUtils?: { HttpCachePlugin?: new () => unknown };
  }).$folioUtils;
  if (!folioUtils?.HttpCachePlugin) return null;
  return new folioUtils.HttpCachePlugin();
}

function createFolioLinkHandlerPlugins(iframe: HTMLIFrameElement): unknown[] {
  const folioUtils = (window as unknown as {
    $folioUtils?: {
      LinkHandlerPlugin?: new (onNewTab: (url: string, active: boolean) => void) => unknown;
    };
  }).$folioUtils;
  if (!folioUtils?.LinkHandlerPlugin) return [];

  return [
    new folioUtils.LinkHandlerPlugin((url, active) => {
      window.postMessage(
        {
          type: "open-new-tab",
          url,
          decodedUrl: url,
          tabId: iframe.dataset.tabId ?? null,
          isTopFrame: true,
          cause: "folio-link-handler",
          active,
        },
        "*",
      );
    }),
  ];
}

function createFolioPageStatePlugin(iframe: HTMLIFrameElement): unknown {
  const controllerGlobals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  const ManagedPlugin = controllerGlobals?.ManagedPlugin;
  if (!ManagedPlugin) return null;

  return new (class FolioPageStatePlugin extends ManagedPlugin {
    constructor() {
      super("folio-page-state", []);
    }

    override install(frame: any): void {
      super.install(frame);
      this.tap(frame.hooks.init.post, (context: FolioPageState) => {
        if (!context.isTopLevel || !context.window?.document) return;

        const win = context.window as Window & typeof globalThis & {
          __lyraFolioPageStateInstalled?: boolean;
        };
        if (win.__lyraFolioPageStateInstalled) return;
        win.__lyraFolioPageStateInstalled = true;

        const doc = win.document;
        let navigationVersion = iframe.dataset.navigationVersion;
        let pendingTimer: number | null = null;
        let lastSignature = "";

        const currentUrl = (fallback?: unknown): string => {
          const candidate =
            typeof fallback === "string"
              ? fallback
              : fallback instanceof win.URL
                ? fallback.href
              : context.client?.url?.href || win.location.href;
          try {
            return new URL(candidate, context.client?.url?.href || win.location.href).href;
          } catch {
            return String(candidate || "");
          }
        };

        const safeHistoryState = (): unknown => {
          const state = win.history.state;
          if (state === null || typeof state !== "object") return state;
          try {
            return JSON.parse(JSON.stringify(state));
          } catch {
            return { type: Object.prototype.toString.call(state) };
          }
        };

        const readFavicon = (): string | null => {
          const link = doc.querySelector<HTMLLinkElement>(
            'link[rel~="icon"][href], link[rel="shortcut icon"][href], link[rel*="icon"][href]',
          );
          const href = link?.getAttribute("href") || "/favicon.ico";
          try {
            return new URL(href, currentUrl()).href;
          } catch {
            return href || null;
          }
        };

        const readMemory = () => {
          const memory = (win.performance as Performance & {
            memory?: {
              usedJSHeapSize?: number;
              totalJSHeapSize?: number;
              jsHeapSizeLimit?: number;
            };
          }).memory;
          if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
          return {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          };
        };

        const emit = (reason: string, urlOverride?: unknown) => {
          const send = () => {
            if (iframe.dataset.navigationVersion !== navigationVersion) return;

            const url = currentUrl(urlOverride);
            const favicon = readFavicon();
            const title = doc.title || "";
            const historyLength = win.history.length;
            const historyState = safeHistoryState();
            const signature = JSON.stringify([
              url,
              title,
              favicon,
              historyLength,
              historyState,
              reason,
              win.navigation?.currentEntry?.key,
            ]);
            if (signature === lastSignature && reason !== "history-push") return;
            lastSignature = signature;

            const payload: Record<string, unknown> = {
              type: "page-meta",
              source: "folio",
              tabId: iframe.dataset.tabId || iframe.name || null,
              clientId: context.client?.id || null,
              isTopFrame: true,
              url,
              decodedUrl: url,
              href: url,
              title,
              favicon,
              rawFavicon: favicon,
              historyLength,
              historyState,
              navigationType: reason === "init"
                ? win.navigation?.activation?.navigationType ?? "load" : reason,
              historyKey: win.navigation?.currentEntry?.key,
              navigationVersion,
              history: {
                length: historyLength,
                state: historyState,
              },
            };

            const memory = readMemory();
            if (memory) payload.memory = memory;

            try {
              win.parent?.postMessage(payload, "*");
            } catch {}
          };
          if (reason !== "metadata") {
            send();
          } else if (pendingTimer === null) {
            pendingTimer = win.setTimeout(() => { pendingTimer = null; send(); }, 0);
          }
        };

        const wrapHistory = (method: "pushState" | "replaceState") => {
          const original = win.history[method];
          if (typeof original !== "function") return;
          try {
            (win.history as any)[method] = function (
              this: History,
              ...args: Parameters<History["pushState"]>
            ) {
              const result = original.apply(this, args);
              emit(method === "pushState" ? "history-push" : "history-replace", args[2]);
              return result;
            };
          } catch {}
        };

        if (win.navigation) {
          win.navigation.addEventListener("currententrychange", (event) => {
            emit(event.navigationType ?? "metadata");
          });
        } else {
          wrapHistory("pushState");
          wrapHistory("replaceState");
        }

        const observeHead = () => {
          const target = doc.head || doc.documentElement;
          if (!target || !win.MutationObserver) return;
          try {
            const observer = new win.MutationObserver(() => emit("metadata"));
            observer.observe(target, {
              attributeFilter: ["href", "rel"],
              attributes: true,
              characterData: true,
              childList: true,
              subtree: true,
            });
          } catch {}
        };

        observeHead();
        doc.addEventListener("DOMContentLoaded", () => emit("domcontentloaded"), {
          once: true,
        });
        win.addEventListener("load", () => emit("load"), { capture: true });
        win.addEventListener("pageshow", (event) => {
          if (event.persisted) navigationVersion = iframe.dataset.navigationVersion;
          emit(event.persisted ? "traverse" : "pageshow");
        }, { capture: true });
        win.addEventListener("popstate", () => emit("popstate"), { capture: true });
        win.addEventListener("hashchange", () => emit("hashchange"), { capture: true });

        emit("init");
      });
    }
  })();
}

export async function initializeFolioController(options: {
  serviceWorker: ServiceWorker;
  transport: string;
  wispUrl: string;
  refreshTransport?: boolean;
}): Promise<void> {
  const transportKey = `${options.transport}:${options.wispUrl}:${resolveMochiOrigin().href}`;
  if (
    readyPromise &&
    currentTransportKey === transportKey &&
    !options.refreshTransport
  ) {
    await readyPromise;
    controller?.setServiceWorker(options.serviceWorker);
    return;
  }

  currentTransportKey = transportKey;
  const pending = (async () => {
    const transport = await createTransport(options.transport, options.wispUrl);

    if (controller) {
      controller.setServiceWorker(options.serviceWorker);
      controller.setTransport(transport);
    } else {
      const Controller = getControllerConstructor();
      const folioGlobals = (window as unknown as {
        $folio?: FolioRuntimeGlobals;
      }).$folio;
      const nextController = new Controller({
        serviceworker: options.serviceWorker,
        transport,
        config: folioRuntimeConfig(),
        folioConfig:
          folioGlobals?.defaultConfig ?? folioGlobals?.defaultConfigDev,
      });
      await nextController.wait();
      controller = nextController;
      try {
        folioGlobals?.prewarmRewriter?.();
      } catch {}
    }

    await initializeRivet();

    const app = ((window as unknown as Record<string, unknown>)[
      "Lyra"
    ] ??= {}) as Record<string, unknown>;
    app.folioController = controller;
    app.navigateFolio = navigateFolioIframe;
    app.ensureFolioFrame = ensureFolioFrame;
    app.releaseFolioFrame = releaseFolioFrame;

    return controller;
  })();
  readyPromise = pending;

  try {
    await pending;
  } catch (error) {
    if (readyPromise === pending) {
      readyPromise = null;
      currentTransportKey = "";
    }
    throw error;
  }
}

async function waitForFolioController(
  timeoutMs = 10000,
): Promise<FolioControllerInstance> {
  if (!readyPromise) {
    throw new Error(negativeMessage("source-built folio is not initialized"));
  }
  const pending = readyPromise;
  return await new Promise<FolioControllerInstance>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(negativeMessage("source-built folio timed out"))),
      timeoutMs,
    );
    pending.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function ensureFolioFrame(
  iframe: HTMLIFrameElement,
): Promise<FolioFrameInstance> {
  const existing = frameByIframe.get(iframe);
  if (existing) return existing;

  const ctrl = await waitForFolioController();
  const cachePlugin = createFolioHttpCachePlugin();
  const mochiPlugin = createMochiAcceleratorPlugin();
  const pageStatePlugin = createFolioPageStatePlugin(iframe);
  const linkHandlerPlugins = createFolioLinkHandlerPlugins(iframe);
  const rivetPlugins = createRivetFramePlugins(
    (window as unknown as { $folioController?: FolioGlobals }).$folioController
      ?.ManagedPlugin,
    iframe,
  );
  const plugins = [
    cachePlugin,
    mochiPlugin,
    pageStatePlugin,
    ...linkHandlerPlugins,
    ...rivetPlugins,
  ].filter(Boolean);
  const frame = ctrl.createFrame(
    iframe,
    plugins.length > 0 ? { plugins } : undefined,
  );
  frameByIframe.set(iframe, frame);
  return frame;
}

export async function navigateFolioIframe(
  iframe: HTMLIFrameElement,
  url: string,
  shouldNavigate: () => boolean = () => true,
): Promise<void> {
  const frame = await ensureFolioFrame(iframe);
  if (!shouldNavigate()) return;
  iframe.dataset.manualUrl = url;
  frame.go(url);
}

function releaseFolioFrame(iframe: HTMLIFrameElement): void {
  const frame = frameByIframe.get(iframe);
  frameByIframe.delete(iframe);
  frame?.destroy?.();
}
