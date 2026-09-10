import { negativeMessage, NEGATIVE } from "../runtime/messages.ts";

let runtimePromise: Promise<void> | null = null;
let scriptPromise: Promise<void> | null = null;

function hasProxyGlobals(): boolean {
  const runtime = window as typeof window & {
    $folioController?: { Controller?: unknown };
  };
  return Boolean(runtime.$folioController?.Controller);
}

function loadProxyScript(): Promise<void> {
  if (hasProxyGlobals()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-runtime-bundle="true"]',
    );
    const script = existing ?? document.createElement("script");

    const fail = (message: string) => {
      scriptPromise = null;
      script.remove();
      reject(new Error(negativeMessage(message)));
    };

    script.addEventListener(
      "load",
      () => {
        if (!hasProxyGlobals()) {
          fail("proxy runtime loaded without the expected globals");
          return;
        }
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => fail("failed to load the proxy runtime"),
      { once: true },
    );
    if (!existing) {
      script.src = "/b/all.js";
      script.async = true;
      script.dataset.runtimeBundle = "true";
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

export function ensureProxyRuntime(): Promise<void> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = loadProxyScript()
    .then(() => import("./register.ts"))
    .then(() => undefined)
    .catch((error) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}

export function warmProxyRuntime(): void {
  void ensureProxyRuntime().catch((error) => {
    console.warn("proxy runtime warmup failed:", error, NEGATIVE);
  });
}
