import { BareMuxConnection } from "@mercuryworkshop/bare-mux";
import { initializeFolioController } from "./folio";
import {
  formatRuntimeMessage,
  negativeMessage,
  NEGATIVE,
  POSITIVE,
} from "../runtime/messages";
import { runtimeAssetPath, wispPath } from "../runtime/build.ts";

type ConnectionState =
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "FAILED"
  | "RECONNECTING";

interface AppConfig {
  transport: string;
}

interface ResolvablePromise<T = void> extends Promise<T> {
  _resolve: (value: T | PromiseLike<T>) => void;
  _reject: (reason?: unknown) => void;
  _settled: boolean;
}

interface BareMuxConnectionInstance {
  getTransport(): Promise<string>;
  setTransport(module: string, options: Array<{ wisp: string }>): Promise<void>;
}

declare global {
  interface Window {
    lyraConnection: LyraConnectionManager;
  }
}

const STATES = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  FAILED: "FAILED",
  RECONNECTING: "RECONNECTING",
} as const);

const TRANSPORT_MAP: Record<string, string> = {
  epoxy: runtimeAssetPath("epoxy", "index.mjs"),
  libcurl: runtimeAssetPath("libcurl", "index.mjs"),
};

const FOLIO_SCOPE = "/f";

function createResolvablePromise<T = void>(): ResolvablePromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as ResolvablePromise<T>;
  promise._settled = false;
  promise._resolve = (value: T | PromiseLike<T>) => {
    promise._settled = true;
    resolve(value);
  };
  promise._reject = (reason?: unknown) => {
    promise._settled = true;
    reject(reason);
  };
  return promise;
}

class LyraConnectionManager {
  state: ConnectionState;
  appConfig: AppConfig;
  bareMuxConnection: BareMuxConnectionInstance | null;
  currentWispUrl: string;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  isInitialLoad: boolean;
  _transportReadyPromise: ResolvablePromise;
  _retryCount: number;
  _isRecovering: boolean;
  _tabWasHiddenWhileConnected: boolean;

  constructor() {
    this.state = STATES.IDLE;
    this.appConfig = { transport: "epoxy" };
    this.bareMuxConnection = null;
    this.currentWispUrl = "";
    this.healthCheckInterval = null;
    this.isInitialLoad = true;
    this._transportReadyPromise = createResolvablePromise();
    this._retryCount = 0;
    this._isRecovering = false;
    this._tabWasHiddenWhileConnected = false;

    const app = ((window as unknown as Record<string, unknown>)["Lyra"] ??= {}) as typeof window.Lyra;
    app.transportReady = this._transportReadyPromise;

    app.waitForTransport = async (timeoutMs = 10000) => {
      if (this._transportReadyPromise._settled && this.state !== STATES.CONNECTED) {
        this._resetTransportReady();
      } else if (this._transportReadyPromise._settled && this.state === STATES.CONNECTED) {
        const verified = await this._verifyTransport();
        if (!verified) {
          this._resetTransportReady();
          await this.recoverOnWake({ forceReapply: true });
        }
      }
      return Promise.race([
        this._transportReadyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(negativeMessage("transport setup timed out"))),
            timeoutMs,
          ),
        ),
      ]);
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      this.start();
    } else {
      window.addEventListener("DOMContentLoaded", () => this.start());
    }
  }

  start(): void {
    if (!this.preFlightChecks()) return;
    this.loadConfig();
    this.initializeApp();
    this.startHealthCheck();
    this.setupEventListeners();
  }

  _resetTransportReady(): void {
    if (this._transportReadyPromise._settled) {
      this._transportReadyPromise = createResolvablePromise();
      window.Lyra.transportReady = this._transportReadyPromise;
    }
  }

  _resolveTransportReady(): void {
    this._transportReadyPromise._resolve(undefined);
  }

  setState(newState: ConnectionState): void {
    if (!Object.values(STATES).includes(newState)) return;
    this.state = newState;
  }

  preFlightChecks(): boolean {
    if (!navigator.serviceWorker) {
      this.updateStatus("fatal: service workers are not supported!", "error");
      this.setState(STATES.FAILED);
      return false;
    }
    return true;
  }

  updateStatus(message: string, type: string = "info"): void {
    const formattedMessage = formatRuntimeMessage(type, message);
    const statusEl = document.getElementById("connection-status");
    if (statusEl) {
      statusEl.textContent = formattedMessage;
      statusEl.className = `status-${type}`;
    }
    if (type === "error") {
      console.error(`status: ${formattedMessage}`);
    }
  }

  loadConfig(): void {
    try {
      localStorage.removeItem("backend");
      this.appConfig.transport = localStorage.getItem("transport") || "epoxy";
    } catch {
      this.updateStatus("could not access local storage; using defaults", "error");
    }
  }

  async ensureWispServerConnection(url: string, timeout: number = 1500): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket | undefined;
      let settled = false;
      try {
        ws = new WebSocket(url);
      } catch {
        return reject(new Error(negativeMessage("invalid websocket url")));
      }

      const connectionTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
        reject(new Error(negativeMessage("wisp connection timed out")));
      }, timeout);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        ws!.close();
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        reject(new Error(negativeMessage("wisp connection failed")));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        reject(new Error(negativeMessage("wisp connection closed")));
      };
    });
  }

  async _verifyTransport(): Promise<boolean> {
    if (!this.bareMuxConnection) return false;
    try {
      const name = await Promise.race([
        this.bareMuxConnection.getTransport(),
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error(negativeMessage("transport verification timed out"))),
            4000,
          ),
        ),
      ]);
      return name.length > 0;
    } catch (e) {
      console.warn("transport verification failed:", e, NEGATIVE);
      return false;
    }
  }

  async _reapplyTransport(): Promise<boolean> {
    if (!this.bareMuxConnection) return false;
    try {
      const transportModule = TRANSPORT_MAP[this.appConfig.transport];
      if (!transportModule) return false;

      await this.bareMuxConnection.setTransport(transportModule, [
        { wisp: this.currentWispUrl },
      ]);

      const verified = await this._verifyTransport();
      if (verified) {
        this._resolveTransportReady();
        return true;
      }
      return false;
    } catch (e) {
      console.error("failed to reapply transport:", e, NEGATIVE);
      return false;
    }
  }

  async initializeApp(isRetry: boolean = false): Promise<boolean | undefined> {
    if (
      !isRetry &&
      (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING)
    )
      return;
    this.setState(isRetry ? STATES.RECONNECTING : STATES.CONNECTING);

    this._resetTransportReady();

    if (!isRetry) this.updateStatus("connecting...", "info");

    try {
      if (!this.bareMuxConnection) {
        this.bareMuxConnection = new BareMuxConnection(
          runtimeAssetPath("bmux", "worker.js"),
        );
        window.Lyra.bareMuxConnection = this.bareMuxConnection;
      }

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const wispHost = (isLocalDev && window.location.port === '4444')
        ? `${window.location.hostname}:4001`
        : window.location.host;
      this.currentWispUrl = `${protocol}://${wispHost}${wispPath}`;

      await this.ensureWispServerConnection(this.currentWispUrl, 10000);

      const registration = await navigator.serviceWorker.register("./b/sw.js", {
        scope: FOLIO_SCOPE,
        updateViaCache: "none",
      });
      const pendingSw = registration.installing || registration.waiting;
      if (pendingSw && pendingSw.state !== "activated") {
        await new Promise<void>((resolve) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (timeout !== undefined) clearTimeout(timeout);
            pendingSw.removeEventListener("statechange", onStateChange);
            resolve();
          };
          const onStateChange = (e: Event) => {
            if ((e.target as ServiceWorker | null)?.state === "activated") {
              finish();
            }
          };
          pendingSw.addEventListener("statechange", onStateChange);
          timeout = setTimeout(finish, 8000);
        });
      }

      const transportModule = TRANSPORT_MAP[this.appConfig.transport];
      if (!transportModule) {
        throw new Error(negativeMessage(`unknown transport: ${this.appConfig.transport}`));
      }

      await this.bareMuxConnection.setTransport(transportModule, [
        { wisp: this.currentWispUrl },
      ]);

      const transportVerified = await this._verifyTransport();
      if (!transportVerified) {
        throw new Error(negativeMessage("transport verification failed after setup"));
      }

      const serviceWorker =
        registration.active || registration.waiting;
      if (!serviceWorker) {
        throw new Error(
          negativeMessage("folio service worker was unavailable after registration"),
        );
      }
      await initializeFolioController({
        serviceWorker,
        transport: this.appConfig.transport,
        wispUrl: this.currentWispUrl,
        refreshTransport: !this.isInitialLoad || isRetry,
      });

      this._resolveTransportReady();
      this.updateStatus("successfully connected!", "success");
      this.setState(STATES.CONNECTED);
      this._retryCount = 0;
      this.isInitialLoad = false;

      return true;
    } catch (error) {
      this.updateStatus("connection failed", "error");
      console.error("connection failed:", error, NEGATIVE);
      await this.handleConnectionFailure();
      return false;
    }
  }

  async handleConnectionFailure(): Promise<void> {
    this.setState(STATES.RECONNECTING);
    if (this._retryCount < 10) {
      const delay = Math.min(Math.pow(2, this._retryCount) * 500, 15000);
      this._retryCount++;
      this.updateStatus(`retrying in ${delay / 1000}s... (attempt ${this._retryCount}/10)`, "info");
      await new Promise<void>((res) => setTimeout(res, delay));
      await this.initializeApp(true);
    } else {
      this.updateStatus("connection failed after multiple retries!", "error");
      this.setState(STATES.FAILED);
      this._retryCount = 0;
    }
  }

  startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    let isChecking = false;
    this.healthCheckInterval = setInterval(async () => {
      if (document.hidden) return;
      if (
        isChecking ||
        this._isRecovering ||
        this.state === STATES.CONNECTING ||
        this.state === STATES.RECONNECTING
      )
        return;

      const hasLoadingTab = window.Lyra?.tabs?.some((tab) => tab.isLoading);
      if (window.Lyra?.isLoading || hasLoadingTab) return;
      if (this.state !== STATES.CONNECTED) return;

      isChecking = true;
      try {
        await this.ensureWispServerConnection(this.currentWispUrl, 3000);

        const transportAlive = await this._verifyTransport();
        if (!transportAlive) {
          console.warn(
            "health check: transport lost in shared worker; reapplying",
            NEGATIVE,
          );
          this._resetTransportReady();
          const recovered = await this._reapplyTransport();
          if (!recovered) {
            this.updateStatus("transport lost. reconnecting...", "error");
            await this.initializeApp();
          } else {
            console.log("health check: transport recovered", POSITIVE);
          }
        }
      } catch {
        this.updateStatus("health check failed. reconnecting...", "error");
        await this.initializeApp();
      } finally {
        isChecking = false;
      }
    }, 8000);
  }

  async recoverOnWake(options?: { forceReapply?: boolean }): Promise<void> {
    if (
      this._isRecovering ||
      this.state === STATES.CONNECTING ||
      this.state === STATES.RECONNECTING
    )
      return;

    if (this.state === STATES.IDLE) return;
    if (!navigator.onLine) return;

    const forceReapply = options?.forceReapply === true;

    this._isRecovering = true;
    try {
      await this.ensureWispServerConnection(this.currentWispUrl, 3000);

      if (forceReapply && this.state === STATES.CONNECTED && this.bareMuxConnection) {
        this._resetTransportReady();
        console.warn(
          "wake recovery: refreshing proxy transports after repeated failures",
          NEGATIVE,
        );
        this._retryCount = 0;
        await this.initializeApp(true);
        return;
      }

      const alive = await this._verifyTransport();
      if (alive) {
        if (!this._transportReadyPromise._settled) {
          this._resolveTransportReady();
        }
        if (this.state !== STATES.CONNECTED) {
          this.setState(STATES.CONNECTED);
          this.updateStatus("successfully connected!", "success");
        }
        return;
      }

      console.warn("wake recovery: transport unavailable; reapplying", NEGATIVE);
      this._resetTransportReady();
      const recovered = await this._reapplyTransport();
      if (recovered) {
        console.log("wake recovery: transport recovered after reapply", POSITIVE);
        this.setState(STATES.CONNECTED);
        return;
      }

      console.warn("wake recovery: full reinitialization required", NEGATIVE);
      this._retryCount = 0;
      await this.initializeApp(true);
    } catch (err) {
      console.warn(
        "wake recovery: wisp unreachable; full reinitialization required:",
        err,
        NEGATIVE,
      );
      this._retryCount = 0;
      this._resetTransportReady();
      await this.initializeApp(true);
    } finally {
      this._isRecovering = false;
    }
  }

  setupEventListeners(): void {
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const message = ev.data as { type?: string; url?: string } | null;
      if (!message || message.type !== "lyra-prefetch-bridge") return;
      if (typeof message.url !== "string") return;
      try {
        const url = new URL(message.url);
        if (url.origin !== window.location.origin) return;
        if (url.pathname !== "/f" || !url.searchParams.has("s")) return;
      } catch {
        return;
      }
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return;
      try {
        ctrl.postMessage({ type: "lyra-prefetch", url: message.url });
      } catch (e) {
        console.warn("failed to post a message to the service worker:", e, NEGATIVE);
      }
    });

    const applyLiveChanges = async (updateFn: () => Promise<void>): Promise<void> => {
      if (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) return;

      this.updateStatus("switching engine...", "info");
      this._resetTransportReady();

      await updateFn();

      const success = await this.initializeApp();
      if (success) {
        this.updateStatus("switched successfully!", "success");
      }
    };

    window.addEventListener("online", () => {
      this._retryCount = 0;
      if (
        this.state !== STATES.CONNECTED &&
        this.state !== STATES.CONNECTING &&
        this.state !== STATES.RECONNECTING
      ) {
        this.initializeApp();
      } else if (this.state === STATES.CONNECTED) {
        this._resetTransportReady();
        void this.recoverOnWake({ forceReapply: true });
      }
    });

    window.addEventListener("offline", () => {
      this.updateStatus("network offline!", "error");
      this.setState(STATES.FAILED);
      this._resetTransportReady();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this._tabWasHiddenWhileConnected = this.state === STATES.CONNECTED;
      } else {
        const resumeFromHidden = this._tabWasHiddenWhileConnected;
        this._tabWasHiddenWhileConnected = false;
        if (resumeFromHidden && this.state === STATES.CONNECTED) {
          this._resetTransportReady();
        }
        setTimeout(
          () => void this.recoverOnWake(),
          0,
        );
      }
    });

    window.addEventListener("pageshow", (ev: PageTransitionEvent) => {
      if (!ev.persisted) return;
      if (this.state !== STATES.CONNECTED) return;
      this._resetTransportReady();
      void this.recoverOnWake();
    });

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
        const message = event.data as { type?: string; failures?: number } | null;
        if (message?.type !== "transport-error") return;
        if (this.state !== STATES.CONNECTED) return;

        const failures = message.failures ?? 1;
        if (failures < 3) return;
        console.warn(
          `transport error reported by the service worker (${failures} consecutive failures); recovering`,
          NEGATIVE,
        );
        this._resetTransportReady();
        void this.recoverOnWake({ forceReapply: true });
      });
    }

    document.addEventListener("newTransport", (e) =>
      applyLiveChanges(async () => {
        this.appConfig.transport = (e as CustomEvent<string>).detail;
      }),
    );
  }
}

window.lyraConnection = new LyraConnectionManager();
export {};
