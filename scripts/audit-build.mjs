import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID_LENGTH } from "../build-id.mjs";

const NEGATIVE = "... /ᐠ - ˕ -マ";
const POSITIVE = "!! (˵◝ ⩊  ◜˵マ";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPath = path.join(root, "dist");
const publicRuntimePath = path.join(root, "public", "b");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs"]);
const olderBrandPattern = new RegExp(["wa", "ves"].join(""), "gi");
const previousBrandPattern = new RegExp(["ma", "ia"].join(""), "gi");
const sensitiveTerm = "(?:games?|anime|proxy|rivet|folio|lyra)";
const sensitiveCssPatterns = [
  new RegExp(`[.#][_a-zA-Z][\\w-]*${sensitiveTerm}[\\w-]*`, "i"),
  new RegExp(`--[_a-zA-Z][\\w-]*${sensitiveTerm}[\\w-]*`, "i"),
  new RegExp(`@(?:-webkit-)?keyframes\\s+[_a-zA-Z][\\w-]*${sensitiveTerm}[\\w-]*`, "i"),
];
const forbiddenText = [
  "bare-mux-path",
  "/bmux/worker.js",
  "/epoxy/index.mjs",
  "/libcurl/index.mjs",
  "FolioClient",
  "FolioFetchHandler",
  "FolioFetchTrackedClient",
  "FolioHeaders",
  "FOLIOCLIENT",
  "ManagedPlugin",
  "CatchEscapedLinksPlugin",
  "EventHandlerPlugin",
  "HttpCachePlugin",
  "LinkHandlerPlugin",
  "UrlWatcherPlugin",
  "assertRuntimeFolioVersion",
  "$folioerr",
  "$folio$setrealmfn",
  "$folioController",
  "$folioUtils",
  "folio client global",
  "folio original onevent function",
  "folio-injected",
  "/b/all.js",
  "/b/fl/folio.js",
  "/b/fl/controller.inject.js",
  "/b/fl/controller.sw.js",
  "/b/fl/folio.wasm",
  "/b/rv/router.js",
  "/b/rivet/ublock.crx",
  "games-view",
  "anime-view",
  "rivet-toolbar",
  "lyra-shell",
  "lyra-runtime",
];
const signalLimits = [
  { label: "older-brand", pattern: olderBrandPattern, maximum: 0 },
  { label: "previous-brand", pattern: previousBrandPattern, maximum: 0 },
  { label: "game", pattern: /games?/gi, maximum: 0 },
  { label: "proxy", pattern: /proxy/gi, maximum: 0 },
  { label: "rivet", pattern: /rivet/gi, maximum: 10 },
  { label: "folio", pattern: /folio/gi, maximum: 100 },
  { label: "anime", pattern: /anime/gi, maximum: 30 },
  { label: "lyra", pattern: /lyra/gi, maximum: 20 },
];

async function collectFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(filePath)));
    else files.push(filePath);
  }
  return files;
}

function fail(message, values = []) {
  const detail = values.length > 0 ? `: ${values.join(", ")}` : "";
  throw new Error(`${message}${detail}${NEGATIVE}`);
}

const packageMetadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (packageMetadata.name !== "lyra" || packageMetadata.version !== "0.0.4") {
  fail("application metadata does not match the lyra release");
}

const distFiles = await collectFiles(distPath);
if (distFiles.length === 0) fail("production output is missing");

let buildMetadata;
try {
  buildMetadata = JSON.parse(
    await readFile(path.join(distPath, "build-meta.json"), "utf8"),
  );
} catch {
  fail("production build metadata is missing");
}
if (
  typeof buildMetadata.build !== "string" ||
  !new RegExp(`^[a-f0-9]{${BUILD_ID_LENGTH}}$`).test(buildMetadata.build)
) {
  fail(`production build id must be ${BUILD_ID_LENGTH} hexadecimal characters`);
}

const publicRuntimeFiles = await collectFiles(publicRuntimePath);
const sourceMaps = [...distFiles, ...publicRuntimeFiles].filter(
  (filePath) => path.extname(filePath).toLowerCase() === ".map",
);
if (sourceMaps.length > 0) {
  fail(
    "production source maps are present",
    sourceMaps.map((filePath) => path.relative(root, filePath)),
  );
}

const invalidAssetNames = distFiles
  .filter((filePath) => [".css", ".js", ".mjs"].includes(path.extname(filePath)))
  .map((filePath) => path.relative(distPath, filePath).replaceAll(path.sep, "/"))
  .filter(
    (fileName) =>
      !new RegExp(
        `^assets/${buildMetadata.build}/[A-Za-z0-9_-]{12}\\.(?:css|js)$`,
      ).test(fileName) &&
      !/^b\/[a-f0-9]{10,12}\.m?js$/.test(fileName),
  );
if (invalidAssetNames.length > 0) {
  fail("production script or style names are not opaque", invalidAssetNames);
}

const leakedFiles = [];
const signalCounts = new Map(signalLimits.map(({ label }) => [label, 0]));
for (const filePath of distFiles) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wasm") {
    const binary = await readFile(filePath);
    if (["$folioerr", "$folio$setrealmfn"].some((hook) => binary.includes(hook))) {
      fail("production wasm contains legacy hook names");
    }
  }
  if (!textExtensions.has(extension)) continue;
  const source = await readFile(filePath, "utf8");
  const relativePath = path.relative(distPath, filePath).replaceAll(path.sep, "/");

  if (/sourceMappingURL\s*=/.test(source)) {
    leakedFiles.push(`${relativePath}:source-map-comment`);
  }
  if (
    extension === ".css" &&
    sensitiveCssPatterns.some((pattern) => pattern.test(source))
  ) {
    leakedFiles.push(`${relativePath}:css-identifier`);
  }
  for (const text of forbiddenText) {
    if (source.includes(text)) leakedFiles.push(`${relativePath}:${text}`);
  }
  for (const { label, pattern } of signalLimits) {
    signalCounts.set(label, signalCounts.get(label) + (source.match(pattern)?.length ?? 0));
  }
}
if (leakedFiles.length > 0) {
  fail("production artifacts contain blocked static signals", leakedFiles);
}

const excessiveSignals = signalLimits
  .filter(({ label, maximum }) => signalCounts.get(label) > maximum)
  .map(
    ({ label, maximum }) =>
      `${label}=${signalCounts.get(label)} (maximum ${maximum})`,
  );
if (excessiveSignals.length > 0) {
  fail("production static signal limits were exceeded", excessiveSignals);
}

console.log(`production artifact audit passed${POSITIVE}`);
