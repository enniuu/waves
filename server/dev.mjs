import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { Agent, createServer, request } from "http";
import express from "express";
import { createDevRuntime } from "./dev-secrets.mjs";
import { httpError } from "./errors.mjs";
import {
  NEGATIVE,
  negativeMessage,
  positiveMessage,
} from "../src/core/runtime/messages.ts";
import {
  createSearchSuggestionService,
  normalizeSearchSuggestionQuery,
  SEARCH_SUGGESTION_PROVIDER,
} from "./searchSuggestions.mjs";
import { createSourceBuildId } from "../build-id.mjs";

let shuttingDown = false;

const ROOT = process.cwd();
const devRuntime = createDevRuntime();
let cleanupOnExit = () => devRuntime.cleanup();
process.on("exit", () => cleanupOnExit());
Object.assign(process.env, devRuntime.env);
const DEV_SERVICE_ENV = devRuntime.env;
const searchSuggestionService = createSearchSuggestionService();

const PORT = Number.parseInt(process.env.PORT || "4444", 10);
const DEV_MOCHI_PORT = Number.parseInt(process.env.MOCHI_PORT || "4002", 10);
const DEV_ISAO_PORT = Number.parseInt(process.env.ISAO_PORT || "4003", 10);
const DEV_CLOUDSYNC_PORT = Number.parseInt(process.env.CLOUDSYNC_PORT || "4005", 10);
const packageJsonPath = path.join(ROOT, "package.json");
const srcPath = path.join(ROOT, "src");
const publicPath = path.join(ROOT, "public");
const baremuxPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "bare-mux",
  "dist",
);
const epoxyPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "epoxy-transport",
  "dist",
);
const libcurlPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "libcurl-transport",
  "dist",
);

const NO_STORE_CC = "no-store, max-age=0";
const NO_CACHE_CC = "public, max-age=0, must-revalidate";
const proxyAgent = new Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 60_000,
});

let packageData = null;
try {
  packageData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch {}

function turnConfigForRequest(req) {
  if (process.env.WEBRTC_TURN_ENABLED === "0") {
    return { enabled: false, forceRelay: false, iceServers: [] };
  }
  const host =
    process.env.TURN_HOST ||
    req.hostname ||
    req.headers.host?.split(":")[0] ||
    "127.0.0.1";
  const port = process.env.TURN_PORT || "3478";
  const username = process.env.TURN_USERNAME || "lyly";
  const credential = process.env.TURN_CREDENTIAL || "rara";
  return {
    enabled: true,
    forceRelay: process.env.WEBRTC_FORCE_RELAY !== "0",
    iceServers: [
      {
        urls: [
          `turn:${host}:${port}?transport=udp`,
          `turn:${host}:${port}?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  };
}
function buildFingerprint() {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(srcPath, "build-meta.json"), "utf-8"),
    );
    if (typeof meta.build === "string" && meta.build.length > 0) {
      return meta.build;
    }
  } catch {}

  try {
    return createSourceBuildId(ROOT);
  } catch {
    return `${packageData?.version || "dev"}-${process.pid}`;
  }
}

const bundleSourceById = {
  1: path.join(baremuxPath, "index.js"),
  2: path.join(publicPath, "b/fl/folio.js"),
  5: path.join(publicPath, "b/fl/controller.api.js"),
  6: path.join(publicPath, "b/fl/folio-utils.js")
};

const bundleById = {};
for (const [id, filePath] of Object.entries(bundleSourceById)) {
  try {
    bundleById[id] = fs.readFileSync(filePath);
  } catch {}
}

const fallbackBundle = (() => {
  const parts = Object.entries(bundleById)
    .filter(([id]) => id !== "1")
    .map(([, bundle]) =>
      Buffer.from(
        bundle
          .toString("utf-8")
          .replace(/\r\n/g, "\n")
          .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
          .trim(),
        "utf-8",
      ),
    );
  if (parts.length === 0) return null;
  return Buffer.concat(
    parts.flatMap((part, index) =>
      index === 0 ? [part] : [Buffer.from(";\n"), part],
    ),
  );
})();

function setIsolationHeaders(_req, res, next) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}

function sendText(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", NO_STORE_CC);
  res.end(body);
}

function proxyTarget(url) {
  if (url.startsWith("/w/")) return { port: 4001, label: "nuru" };
  if (
    url.startsWith("/!!raw/") ||
    url.startsWith("/!!/") ||
    url.startsWith("/!!folio/") ||
    url.startsWith("/!cover!/") ||
    (url.startsWith("/stream/") && !url.startsWith("/stream/anime"))
  ) {
    return { port: DEV_MOCHI_PORT, label: "mochi" };
  }
  if (url.startsWith("/api/auth") || url.startsWith("/api/sync")) {
    return { port: DEV_CLOUDSYNC_PORT, label: "cloudsync" };
  }
  if (url.startsWith("/api/anime")) {
    return { port: DEV_ISAO_PORT, label: "isao" };
  }
  return null;
}

async function serveSearchSuggestions(req, res) {
  const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
  const query = normalizeSearchSuggestionQuery(rawQuery);
  res.setHeader("Cache-Control", NO_STORE_CC);
  if (!query) {
    return res.json({
      query: "",
      suggestions: [],
      provider: SEARCH_SUGGESTION_PROVIDER,
    });
  }

  try {
    const suggestions = await searchSuggestionService.get(query);
    return res.json({
      query,
      suggestions,
      provider: SEARCH_SUGGESTION_PROVIDER,
    });
  } catch (error) {
    console.error("search suggestion request failed:", error, NEGATIVE);
    const failure = httpError(
      502,
      "SEARCH_SUGGESTIONS_UNAVAILABLE",
      "search suggestions are temporarily unavailable",
      { provider: SEARCH_SUGGESTION_PROVIDER },
    );
    return res.status(failure.status).json(failure.body);
  }
}

function proxyDevService(req, res, next) {
  if (req.headers.upgrade?.toLowerCase() === "websocket") return next();

  const target = proxyTarget(req.url);
  if (!target) return next();

  const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
      agent: proxyAgent,
      timeout: 45_000,
    },
    (proxyRes) => {
      proxyRes.on("error", () => res.destroy());
      res.on("error", () => proxyRes.destroy());

      const safeHeaders = { ...proxyRes.headers };
      delete safeHeaders.connection;
      delete safeHeaders["keep-alive"];
      delete safeHeaders["transfer-encoding"];
      delete safeHeaders.upgrade;
      delete safeHeaders.date;

      res.writeHead(proxyRes.statusCode || 502, safeHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error(negativeMessage(`${target.label} timed out`)));
  });

  proxyReq.on("error", (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    console.error(`${target.label} forwarding failed:`, err, NEGATIVE);
    const failure = httpError(
      502,
      "DEV_SERVICE_UNAVAILABLE",
      "development service is unavailable",
    );
    res.status(failure.status).json(failure.body);
  });

  req.on("error", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function serveBundleAll(_req, res) {
  const bundlePath = path.join(srcPath, "b", "all.js");
  if (fs.existsSync(bundlePath)) return res.sendFile(bundlePath);

  if (!fallbackBundle) {
    return sendText(res, 404, negativeMessage("bundle not found"));
  }

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", NO_CACHE_CC);
  res.send(fallbackBundle);
}

async function transformHtml(vite, req, res, filePath, url = req.originalUrl || req.url) {
  res.setHeader("Cache-Control", NO_STORE_CC);
  try {
    let html = fs.readFileSync(filePath, "utf-8");
    html = await vite.transformIndexHtml(url, html);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).end(html);
  } catch (err) {
    console.error("vite transform failed:", err, NEGATIVE);
    res.sendFile(filePath);
  }
}

function transpileTsFallback(req, res, next) {
  let filePath = path.join(srcPath, req.path);
  if (req.path.endsWith(".js") && !fs.existsSync(filePath)) {
    const tsPath = filePath.slice(0, -3) + ".ts";
    const tsxPath = filePath.slice(0, -3) + ".tsx";
    if (fs.existsSync(tsPath)) filePath = tsPath;
    else if (fs.existsSync(tsxPath)) filePath = tsxPath;
  }

  if (!/\.(ts|tsx)$/.test(filePath) || !fs.existsSync(filePath)) return next();

  try {
    const code = fs.readFileSync(filePath, "utf-8");
    const result = new Bun.Transpiler({
      loader: filePath.endsWith(".tsx") ? "tsx" : "ts",
    }).transformSync(code);
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", NO_CACHE_CC);
    res.send(result);
  } catch (err) {
    console.error("typescript transpilation failed:", err, NEGATIVE);
    sendText(res, 500, negativeMessage("typescript transpilation failed"));
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(setIsolationHeaders);
app.get("/b/all.js", serveBundleAll);
app.get("/b", (req, res) => {
  const bundle = bundleById[req.query.id];
  if (!bundle) return sendText(res, 404, negativeMessage("file not found"));
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", NO_CACHE_CC);
  res.send(bundle);
});
app.get("/api/search/suggestions", serveSearchSuggestions);
app.use(proxyDevService);

const swStaticOpts = { maxAge: 0, etag: true };
app.get("/b/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/f");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", NO_CACHE_CC);
  res.sendFile(path.join(srcPath, "b", "sw.js"));
});
app.use("/b/sw", express.static(path.join(srcPath, "b", "sw"), swStaticOpts));

const { createServer: createViteServer } = await import("vite");
const server = createServer(app);
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: ["6dc7-84-20-18-38.ngrok-free.app"],
  },
  appType: "custom",
});

app.use(vite.middlewares);
app.use(transpileTsFallback);

const staticOpts = { maxAge: 0, etag: true };
app.use("/bmux/", express.static(baremuxPath, staticOpts));
app.use("/epoxy/", express.static(epoxyPath, staticOpts));
app.use("/libcurl/", express.static(libcurlPath, staticOpts));
app.use("/assets", express.static(path.join(srcPath, "assets"), staticOpts));
app.use("/assets", express.static(path.join(publicPath, "assets"), staticOpts));
app.use("/b", express.static(path.join(publicPath, "b"), staticOpts));
app.use(express.static(srcPath, { ...staticOpts, index: false }));

app.get("/api/stuff", (req, res) => {
  if (!packageData) {
    const failure = httpError(
      500,
      "SERVICE_METADATA_UNAVAILABLE",
      "service metadata is unavailable",
    );
    return res.status(failure.status).json(failure.body);
  }
  res.setHeader("Cache-Control", NO_STORE_CC);
  res.json({
    version: packageData.version,
    build: buildFingerprint(),
    turn: turnConfigForRequest(req),
  });
});

app.get("/s", (req, res) => {
  transformHtml(vite, req, res, path.join(srcPath, "index.html"));
});

app.get("/stream/anime", (req, res) => {
  transformHtml(vite, req, res, path.join(srcPath, "player.html"), "/stream/anime");
});

app.get("/", (req, res) => {
  transformHtml(vite, req, res, path.join(srcPath, "index.html"));
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(srcPath, "404.html"));
});

server.keepAliveTimeout = 60_000;
server.headersTimeout = 61_000;
const connections = new Set();
server.on("connection", (conn) => {
  connections.add(conn);
  conn.on("close", () => connections.delete(conn));
});

const ALL_DEV_SERVICES = [
  {
    name: "turn",
    requiresEphemeralSecrets: true,
    port: Number.parseInt(process.env.TURN_PORT || "3478", 10),
    command: ["docker", "compose", "-f", "services/turn/compose.yml", "up"],
    shutdownCommand: ["docker", "compose", "-f", "services/turn/compose.yml", "down"],
  },
  {
    name: "nuru",
    dir: "services/nuru",
    port: 4001,
    args: ["--", "config.toml", "--format", "toml"],
  },
  {
    name: "mochi",
    dir: "services/mochi",
    port: 4002,
    requiresEphemeralSecrets: true,
  },
  {
    name: "cloudsync",
    dir: "services/cloudsync",
    port: DEV_CLOUDSYNC_PORT,
    requiresEphemeralSecrets: true,
  },
  {
    name: "isao",
    dir: "services/isao",
    port: 4003,
    requiresEphemeralSecrets: true,
  },
];

function selectedServices() {
  if (process.env.DEV_AUTOSTART === "0") return [];

  const raw = process.env.DEV_SERVICES || "all";
  if (raw === "all") return ALL_DEV_SERVICES;

  const selected = new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return ALL_DEV_SERVICES.filter((svc) => selected.has(svc.name));
}

const DEV_SERVICES = selectedServices();
const SERVICE_STATE = Object.freeze({
  STARTING: "starting",
  COMPILING: "compiling",
  READY: "ready",
  EXTERNAL: "external",
  ERROR: "error",
  STOPPED: "stopped",
  EXITED: "exited",
});
const serviceStatus = {};
const serviceProcs = [];
let statusLineCount = 0;

function setServiceStatus(name, state, detail) {
  serviceStatus[name] = { state, detail };
}

function serviceStatusText(status) {
  switch (status?.state) {
    case SERVICE_STATE.STARTING:
      return "starting...";
    case SERVICE_STATE.COMPILING:
      return "compiling...";
    case SERVICE_STATE.READY:
      return positiveMessage("ready");
    case SERVICE_STATE.EXTERNAL:
      return "external";
    case SERVICE_STATE.STOPPED:
      return negativeMessage(`stopped (${status.detail})`);
    case SERVICE_STATE.EXITED:
      return negativeMessage(`exited (${status.detail})`);
    default:
      return negativeMessage(status?.detail || "service failed");
  }
}

function colorize(status) {
  const text = serviceStatusText(status);
  if (
    status?.state === SERVICE_STATE.READY ||
    status?.state === SERVICE_STATE.EXTERNAL
  ) {
    return `\x1b[32m${text}\x1b[0m`;
  }
  if (
    status?.state === SERVICE_STATE.STARTING ||
    status?.state === SERVICE_STATE.COMPILING
  ) {
    return `\x1b[33m${text}\x1b[0m`;
  }
  return `\x1b[31m${text}\x1b[0m`;
}

function printStatus() {
  if (statusLineCount > 0) process.stdout.write(`\x1b[${statusLineCount}A\x1b[0J`);

  const lines = ["", "services:"];
  if (DEV_SERVICES.length === 0) {
    lines.push(" autostart ~ \x1b[33mdisabled\x1b[0m");
  } else {
    for (const svc of DEV_SERVICES) {
      lines.push(` ${svc.name.padEnd(9)} ~ ${colorize(serviceStatus[svc.name])}`);
    }
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
  statusLineCount = lines.length - 1;
}

async function checkPort(port, timeout = 400) {
  try {
    await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.end();
        },
        data() {},
      },
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

async function pollService(svc) {
  while (
    serviceStatus[svc.name]?.state === SERVICE_STATE.STARTING ||
    serviceStatus[svc.name]?.state === SERVICE_STATE.COMPILING
  ) {
    if (await checkPort(svc.port)) {
      setServiceStatus(svc.name, SERVICE_STATE.READY);
      printStatus();
      return;
    }
    await Bun.sleep(750);
  }
}

async function stopStaleManagedService(svc) {
  if (!svc.shutdownCommand) return false;
  try {
    Bun.spawnSync(svc.shutdownCommand, {
      cwd: ROOT,
      env: DEV_SERVICE_ENV,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await checkPort(svc.port, 150))) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function spawnServices() {
  if (DEV_SERVICES.length === 0) {
    printStatus();
    return;
  }

  for (const svc of DEV_SERVICES) {
    setServiceStatus(svc.name, SERVICE_STATE.STARTING);
  }
  printStatus();

  for (const svc of DEV_SERVICES) {
    let portOccupied = await checkPort(svc.port, 150);
    if (portOccupied && svc.shutdownCommand) {
      portOccupied = !(await stopStaleManagedService(svc));
    }
    if (portOccupied) {
      setServiceStatus(
        svc.name,
        svc.requiresEphemeralSecrets ? SERVICE_STATE.ERROR : SERVICE_STATE.EXTERNAL,
        svc.requiresEphemeralSecrets
          ? "port is occupied by a stale service"
          : undefined,
      );
      printStatus();
      continue;
    }

    let child;
    try {
      const command =
        svc.command ||
        (process.platform === "win32"
          ? ["cmd.exe", "/c", "cargo", "run", "--quiet", ...(svc.args || [])]
          : ["cargo", "run", "--quiet", ...(svc.args || [])]);
      child = Bun.spawn(command, {
        cwd: svc.dir ? path.join(ROOT, svc.dir) : ROOT,
        env: DEV_SERVICE_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      setServiceStatus(
        svc.name,
        SERVICE_STATE.ERROR,
        "service process could not be started",
      );
      printStatus();
      continue;
    }

    serviceProcs.push({ svc, child });
    watchServiceOutput(svc, child);
    pollService(svc);
  }
}

function watchServiceOutput(svc, child) {
  const showLogs = process.env.DEV_SERVICE_LOGS !== "0";
  const markReady = (text) => {
    const lower = text.toLowerCase();
    if (
      serviceStatus[svc.name]?.state !== SERVICE_STATE.READY &&
      (lower.includes("listening") ||
        lower.includes("started") ||
        lower.includes("running") ||
        lower.includes("ready"))
    ) {
      setServiceStatus(svc.name, SERVICE_STATE.READY);
      printStatus();
    } else if (
      serviceStatus[svc.name]?.state === SERVICE_STATE.STARTING &&
      lower.includes("compiling")
    ) {
      setServiceStatus(svc.name, SERVICE_STATE.COMPILING);
      printStatus();
    }
  };

  const drain = async (stream, isError) => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        markReady(text);
        if (showLogs || isError && /error|panic|failed/i.test(text)) {
          process.stderr.write(`[${svc.name}] ${text}`);
        }
      }
    } catch {}
  };

  drain(child.stdout, false);
  drain(child.stderr, true);

  child.exited
    .then((exitCode) => {
      if (serviceStatus[svc.name]?.state === SERVICE_STATE.READY) {
        setServiceStatus(svc.name, SERVICE_STATE.STOPPED, exitCode);
      } else {
        setServiceStatus(svc.name, SERVICE_STATE.EXITED, exitCode);
      }
      printStatus();
    })
    .catch(() => {});
}

function killServices() {
  for (const { child } of serviceProcs) {
    try {
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/f", "/t"], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }

  setTimeout(() => {
    for (const { child } of serviceProcs) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 2000).unref?.();

  for (const { svc } of serviceProcs) {
    if (!svc.shutdownCommand) continue;
    try {
      Bun.spawnSync(svc.shutdownCommand, {
        cwd: ROOT,
        env: DEV_SERVICE_ENV,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {}
  }
}

async function gracefulShutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log("\nshutting down");
  killServices();
  proxyAgent.destroy();
  await vite.close().catch(() => {});
  for (const conn of connections) conn.destroy();
  connections.clear();
  server.close(() => {
    console.log(positiveMessage(`port ${PORT} released`));
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4444).unref?.();
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
cleanupOnExit = () => {
  killServices();
  devRuntime.cleanup();
};

server.listen(PORT, () => {
  console.log(``)
  console.log(positiveMessage(`dev server listening on ${PORT}`));
  spawnServices();
});
