import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import lyraPlugin from "./build.js";
import { createSourceBuildId } from "./build-id.mjs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const buildId = createSourceBuildId(__dirname, process.env.LYRA_WISP_PATH || "");
const assetPath = `assets/${buildId}/[hash:12]`;

export default defineConfig({
  plugins: [
    preact(),
    lyraPlugin(buildId),
  ],
  root: "src",
  publicDir: false,
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 550,
    target: "baseline-widely-available",
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, passes: 2 },
      mangle: true,
    },
    cssMinify: "lightningcss",
    assetsInlineLimit: 8192,
    rolldownOptions: {
      checks: { pluginTimings: false },
      input: {
        main: resolve(__dirname, "src/index.html"),
        "404": resolve(__dirname, "src/404.html"),
        "player": resolve(__dirname, "src/player.html"),
      },
      output: {
        entryFileNames: `${assetPath}.js`,
        chunkFileNames: `${assetPath}.js`,
        assetFileNames: `${assetPath}[extname]`,
        minifyInternalExports: true,
        manualChunks(id) {
          if (id.includes("components/icons/paths")) return "paths";
          if (id.includes("node_modules/preact")) return "preact";
          if (id.includes("node_modules/zustand")) return "zustand";
          if (id.includes("node_modules/hls.js")) return "hls";
          if (id.includes("node_modules/jszip")) return "extension-vendor";
          if (id.includes("node_modules/@mercuryworkshop")) {
            return "proxy-vendor";
          }
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
      generateScopedName: "x_[hash:base64:10]",
    },
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
});
