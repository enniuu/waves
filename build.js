import path from "path";
import { cp, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync, } from "zlib";
import { createHash } from "crypto";
import JavaScriptObfuscator from "javascript-obfuscator";
import { createSourceBuildId } from "./build-id.mjs";

const { obfuscate } = JavaScriptObfuscator;

const SENSITIVE_TERM = /(games?|anime|proxy|rivet|folio|lyra)/i;
const SENSITIVE_STRING_PATTERN =
  "[Gg]ames?|[Aa]nime|[Pp]roxy|[Rr]ivet|[Ff]olio|[Ll]yra";
const ZERO_MATCH_TERM = /games?|proxy/gi;

export const FOLIO_RUNTIME_TOKENS = [
  "$folio", "$folioController", "$folioUtils",
  "$folio$wrap", "$folio__", "$folio$prop", "$folio$clean",
  "$folio$import", "$folio$rewrite", "$folio$meta",
  "$folio$wrappostmessage", "$folio$pushsourcemap", "$folio$tryset",
  "$folio$temploc", "$folio$tempunused",
  "$folioerr", "$folio$setrealmfn",
  "$folio$messagetype", "$folio$origin", "$folio$data",
  "folio client global", "folio realm pollutant",
  "folio original onevent function", "controller frame handle",
  "folio-injected",
  "FolioClient", "FolioFetchHandler", "FolioFetchTrackedClient", "FolioHeaders",
  "FOLIOCLIENT", "FOLIOCLIENTNAME", "assertRuntimeFolioVersion",
  "ManagedPlugin", "CatchEscapedLinksPlugin", "EventHandlerPlugin",
  "HttpCachePlugin", "LinkHandlerPlugin", "UrlWatcherPlugin",
];

export function createFolioTokenMap(buildId) {
  return new Map(FOLIO_RUNTIME_TOKENS.map((token) => [
    token,
    `x${createHash("sha256").update(`${buildId}\0folio-runtime\0${token}`).digest("hex").slice(0, 20)}`,
  ]));
}

const OBFUSCATION_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  forceTransformStrings: [SENSITIVE_STRING_PATTERN],
  identifierNamesGenerator: "mangled",
  log: false,
  renameGlobals: true,
  renameVariables: true,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 1,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

const RUNTIME_OBFUSCATION_OPTIONS = {
  ...OBFUSCATION_OPTIONS,
  renameGlobals: false,
  renameVariables: false,
};

const BASIC_OBFUSCATION_OPTIONS = {
  ...OBFUSCATION_OPTIONS,
  forceTransformStrings: [],
  stringArray: false,
  stringArrayEncoding: [],
};

const RUNTIME_ASSETS = [
  {
    logicalPath: "/bmux/worker.js",
    source: ["node_modules", "@mercuryworkshop", "bare-mux", "dist", "worker.js"],
  },
  ...["epoxy", "libcurl"].map((transport) => ({
    logicalPath: `/${transport}/index.mjs`,
    source: ["node_modules", "@mercuryworkshop", `${transport}-transport`, "dist", "index.mjs"],
  })),
  { logicalPath: "/b/fl/folio.js", source: ["public", "b", "fl", "folio.js"] },
  {
    logicalPath: "/b/fl/controller.inject.js",
    source: ["public", "b", "fl", "controller.inject.js"],
  },
  {
    logicalPath: "/b/fl/controller.sw.js",
    source: ["public", "b", "fl", "controller.sw.js"],
  },
  { logicalPath: "/b/fl/folio.wasm", source: ["public", "b", "fl", "folio.wasm"] },
  { logicalPath: "/b/rv/router.js", source: ["public", "b", "rv", "router.js"] },
  {
    logicalPath: "/b/rivet/ublock.crx",
    source: ["packages", "rivet", "extensions", "ublock.crx"],
  },
];

const SW_MODULES = [
  "constants.js",
  "state.js",
  "init.js",
  "utils.js",
  "decode.js",
  "inject.js",
  "network.js",
  "messaging.js",
  "handler.js",
];

function stripSourceMapComments(source) {
  return source
    .replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, "")
    .replace(/\/\*[#@]\s*sourceMappingURL=.*?\*\//gs, "");
}

export function encodeBuildLexemes(source) {
  return source.replace(ZERO_MATCH_TERM, (match) => {
    const escapedCharacter = match.charCodeAt(1).toString(16).padStart(4, "0");
    return `${match[0]}\\u${escapedCharacter}${match.slice(2)}`;
  });
}

export function obfuscateSource(source, options, identifiersPrefix) {
  const compatibleSource = source.replaceAll("(?i:url)", "[uU][rR][lL]");
  return encodeBuildLexemes(
    obfuscate(compatibleSource, {
      ...options,
      seed: identifiersPrefix || "lyra-build",
      ...(identifiersPrefix ? { identifiersPrefix } : {}),
    }).getObfuscatedCode(),
  );
}

function obfuscationPrefix(buildId, scope) {
  return `x${createHash("sha256")
    .update(`${buildId}\0${scope}\0obfuscation`)
    .digest("hex")
    .slice(0, 10)}`;
}

function opaqueFileName(logicalPath, buildId) {
  const extension = path.extname(logicalPath);
  const hash = createHash("sha256")
    .update(`${buildId}\0${logicalPath}`)
    .digest("hex")
    .slice(0, 12);
  return `b/${hash}${extension}`;
}

export function createRuntimePathMap(buildId) {
  return Object.fromEntries(RUNTIME_ASSETS.map(({ logicalPath }) => [
    logicalPath,
    `/${opaqueFileName(logicalPath, buildId)}`,
  ]));
}

function addSensitiveToken(tokens, token) {
  if (SENSITIVE_TERM.test(token)) tokens.add(token);
}

export function createCssTokenMap(cssSources, salt) {
  const tokens = new Set();

  for (const source of cssSources) {
    for (const match of source.matchAll(/([^{}]+)\{/g)) {
      const header = match[1].trim();
      if (header.startsWith("@")) continue;
      for (const selector of header.matchAll(/[.#]([_a-zA-Z][\w-]*)/g)) {
        addSensitiveToken(tokens, selector[1]);
      }
    }

    for (const customProperty of source.matchAll(/--([_a-zA-Z][\w-]*)/g)) {
      addSensitiveToken(tokens, `--${customProperty[1]}`);
    }
    for (const keyframes of source.matchAll(
      /@(?:-webkit-)?keyframes\s+([_a-zA-Z][\w-]*)/g,
    )) {
      addSensitiveToken(tokens, keyframes[1]);
    }
  }

  return new Map(
    [...tokens].map((token) => {
      const hash = createHash("sha256")
        .update(`${salt}\0${token}`)
        .digest("hex")
        .slice(0, 10);
      return [token, token.startsWith("--") ? `--x${hash}` : `x${hash}`];
    }),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteBuildTokens(source, tokenMap, pathAliases = new Map()) {
  let rewritten = source;
  for (const [logicalPath, emittedPath] of pathAliases) {
    rewritten = rewritten.split(logicalPath).join(emittedPath);
  }
  for (const [token, replacement] of [...tokenMap].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    rewritten = rewritten.replace(
      new RegExp(
        `(?<![A-Za-z0-9_$-])${escapeRegExp(token)}(?![A-Za-z0-9_$-])`,
        "g",
      ),
      replacement,
    );
  }
  return rewritten;
}

function containsAppCode(chunk, projectRoot) {
  const appRoot = path.join(projectRoot, "src") + path.sep;
  const rivetRoot = path.join(projectRoot, "packages", "rivet") + path.sep;
  return Object.keys(chunk.modules ?? {}).some(
    (moduleId) => moduleId.startsWith(appRoot) || moduleId.startsWith(rivetRoot),
  );
}

export default function lyraPlugin(
  buildId = createSourceBuildId(process.cwd()),
  wispPath = process.env.LYRA_WISP_PATH ?? "/w/",
) {
  let outputDirectory;
  let serviceWorkerSourceDirectory;
  let projectRoot;

  return {
    name: "lyra-build",
    enforce: "post",

    config(_config, { command }) {
      if (command === "build" && !/^\/(?:w|[a-f0-9]{64})\/$/.test(wispPath)) {
        throw new Error("invalid wisp endpoint... /ᐠ - ˕ -マ");
      }
      return {
        define: {
          __LYRA_WISP_PATH__: JSON.stringify(command === "build" ? wispPath : "/w/"),
          __LYRA_BUILD_ID__: JSON.stringify(command === "build" ? buildId : ""),
          __LYRA_RUNTIME_PATHS__: JSON.stringify(command === "build"
            ? Object.fromEntries(Object.entries(createRuntimePathMap(buildId)).map(([key, value]) => [key.slice(1), value]))
            : {}),
        },
      };
    },

    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
      serviceWorkerSourceDirectory = path.join(config.root, "b", "sw");
      projectRoot = path.resolve(config.root, "..");
    },

    async writeBundle(_options, bundle) {
      const precacheAssets = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!fileName.startsWith("assets/")) continue;
        if (
          (chunk.type === "chunk" && fileName.endsWith(".js")) ||
          (chunk.type === "asset" && fileName.endsWith(".css"))
        ) {
          precacheAssets.push("/" + fileName);
        }
      }

      await mkdir(path.join(outputDirectory, "b"), { recursive: true });

      const cssFiles = Object.entries(bundle)
        .filter(
          ([fileName, output]) =>
            output.type === "asset" && fileName.endsWith(".css"),
        )
        .map(([fileName]) => path.join(outputDirectory, fileName));
      const cssSources = await Promise.all(
        cssFiles.map((filePath) => readFile(filePath, "utf8")),
      );
      const cssTokenMap = new Map([
        ...createCssTokenMap(cssSources, buildId),
        ...createFolioTokenMap(buildId),
        ["bare-mux-path", `x${createHash("sha256").update(`${buildId}\0bare-mux-path`).digest("hex").slice(0, 20)}`],
      ]);

      const pathAliases = new Map(Object.entries(createRuntimePathMap(buildId)));
      const runtimeBundleFileName = opaqueFileName("/b/all.js", buildId);
      pathAliases.set("/b/all.js", `/${runtimeBundleFileName}`);

      for (const { logicalPath, source } of RUNTIME_ASSETS) {
        const sourcePath = path.join(projectRoot, ...source);
        const emittedPath = path.join(
          outputDirectory,
          pathAliases.get(logicalPath).slice(1),
        );
        let contents;
        try {
          contents = await readFile(sourcePath);
        } catch {
          throw new Error("required runtime artifact is missing... /ᐠ - ˕ -マ");
        }

        if (/\.(m?js)$/.test(logicalPath)) {
          const sourceCode = rewriteBuildTokens(
            stripSourceMapComments(contents.toString("utf8")),
            cssTokenMap,
            pathAliases,
          );
          contents = obfuscateSource(
            sourceCode,
            RUNTIME_OBFUSCATION_OPTIONS,
            obfuscationPrefix(buildId, logicalPath),
          );
        }
        await writeFile(emittedPath, contents);
      }

      const bundleInputPaths = [
        path.join(
          projectRoot,
          "node_modules",
          "@mercuryworkshop",
          "bare-mux",
          "dist",
          "index.js",
        ),
        path.join(projectRoot, "public", "b", "fl", "folio.js"),
        path.join(projectRoot, "public", "b", "fl", "controller.api.js"),
        path.join(projectRoot, "public", "b", "fl", "folio-utils.js"),
      ];
      const bundleParts = [
        'try { localStorage.removeItem(["bare", "mux", "path"].join("-")); } catch {}',
      ];
      for (const bundleInputPath of bundleInputPaths) {
        try {
          const sourceCode = stripSourceMapComments(
            (await readFile(bundleInputPath, "utf8")).replace(/\r\n/g, "\n"),
          ).trim();
          bundleParts.push(sourceCode);
        } catch {
          throw new Error("required runtime bundle is missing... /ᐠ - ˕ -マ");
        }
      }
      const runtimeBundle = rewriteBuildTokens(
        bundleParts.join(";\n"),
        cssTokenMap,
        pathAliases,
      );
      await writeFile(
        path.join(outputDirectory, runtimeBundleFileName),
        obfuscateSource(
          runtimeBundle,
          RUNTIME_OBFUSCATION_OPTIONS,
          obfuscationPrefix(buildId, "/b/all.js"),
        ),
      );

      const moduleSources = await Promise.all(
        SW_MODULES.map((moduleName) =>
          readFile(path.join(serviceWorkerSourceDirectory, moduleName), "utf8"),
        ),
      );
      let serviceWorkerCode = moduleSources.join("\n");
      serviceWorkerCode = serviceWorkerCode
        .replace(/__BUILD_ID__/g, buildId)
        .replace(
          /(['"])__PRECACHE_ASSETS__\1/g,
          JSON.stringify(precacheAssets),
        );
      serviceWorkerCode = rewriteBuildTokens(
        serviceWorkerCode,
        cssTokenMap,
        pathAliases,
      );

      const obfuscatedServiceWorker = obfuscateSource(
        serviceWorkerCode,
        OBFUSCATION_OPTIONS,
        obfuscationPrefix(buildId, "/b/sw.js"),
      );
      const serviceWorkerHash = createHash("md5")
        .update(obfuscatedServiceWorker)
        .digest("hex")
        .slice(0, 10);
      const serviceWorkerFileName = `b/${serviceWorkerHash}.js`;
      pathAliases.set("/b/sw.js", `/${serviceWorkerFileName}`);

      await writeFile(
        path.join(outputDirectory, "build-meta.json"),
        JSON.stringify({ build: buildId }),
      );
      await writeFile(
        path.join(outputDirectory, serviceWorkerFileName),
        obfuscatedServiceWorker,
      );

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "asset" && /\.(css|html)$/.test(fileName)) {
          const filePath = path.join(outputDirectory, fileName);
          const sourceCode = await readFile(filePath, "utf8");
          await writeFile(
            filePath,
            rewriteBuildTokens(sourceCode, cssTokenMap, pathAliases),
          );
          continue;
        }
        if (chunk.type !== "chunk") continue;
        const filePath = path.join(outputDirectory, fileName);
        let sourceCode;
        try {
          sourceCode = await readFile(filePath, "utf8");
        } catch {
          continue;
        }

        sourceCode = rewriteBuildTokens(
          sourceCode,
          cssTokenMap,
          pathAliases,
        );
        sourceCode = obfuscateSource(
          sourceCode,
          containsAppCode(chunk, projectRoot)
            ? OBFUSCATION_OPTIONS
            : BASIC_OBFUSCATION_OPTIONS,
          obfuscationPrefix(buildId, fileName),
        );

        await writeFile(filePath, sourceCode);
      }

      const compressionJobs = [];

      async function collectCompressionJobs(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        await Promise.all(
          entries.map(async (entry) => {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              await collectCompressionJobs(filePath);
            } else if (/\.(js|css|html|mjs)$/.test(entry.name)) {
              const contents = await readFile(filePath);
              compressionJobs.push(
                Promise.resolve().then(async () => {
                  const brotli = brotliCompressSync(contents, {
                    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
                  });
                  await writeFile(filePath + ".br", brotli);
                }),
                Promise.resolve().then(async () => {
                  const gzip = gzipSync(contents, { level: 9 });
                  await writeFile(filePath + ".gz", gzip);
                }),
              );
            }
          }),
        );
      }

      await Promise.all(
        ["images"].map(async (assetDirectory) => {
          try {
            await cp(
              path.join(projectRoot, "src", "assets", assetDirectory),
              path.join(outputDirectory, "assets", assetDirectory),
              { recursive: true },
            );
          } catch {}
        }),
      );

      await collectCompressionJobs(outputDirectory);
      await Promise.all(compressionJobs);

      console.log(`\nbuild id: ${buildId}`);
      console.log(`sw: /${serviceWorkerFileName}`);
      console.log(`bundle: /${runtimeBundleFileName}`);
      console.log(`precache: ${precacheAssets.length} asset(s)`);
    },
  };
}
