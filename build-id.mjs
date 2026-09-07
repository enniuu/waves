import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILD_ID_LENGTH = 12;

const BUILD_FINGERPRINT_EXTENSIONS = new Set([
  ".avif",
  ".crx",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".png",
  ".svg",
  ".ts",
  ".tsx",
  ".wasm",
  ".webp",
]);
const BUILD_FINGERPRINT_FILES = [
  "build-id.mjs",
  "build.js",
  "bun.lock",
  "package.json",
  "vite.config.js",
];
const BUILD_FINGERPRINT_DIRECTORIES = [
  path.join("node_modules", "@mercuryworkshop", "bare-mux", "dist"),
  path.join("node_modules", "@mercuryworkshop", "epoxy-transport", "dist"),
  path.join("node_modules", "@mercuryworkshop", "libcurl-transport", "dist"),
];

function collectBuildFiles(directory, files = []) {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectBuildFiles(filePath, files);
      continue;
    }
    if (
      entry.isFile() &&
      BUILD_FINGERPRINT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      files.push(filePath);
    }
  }

  return files;
}

export function createSourceBuildId(root, deployment = "") {
  const hasher = createHash("sha1");
  if (deployment) hasher.update(`deployment\0${deployment}\0`);
  for (const directory of ["src", "public", ...BUILD_FINGERPRINT_DIRECTORIES]) {
    const directoryPath = path.join(root, directory);
    if (!fs.existsSync(directoryPath)) continue;
    for (const filePath of collectBuildFiles(directoryPath)) {
      hasher.update(path.relative(root, filePath));
      hasher.update(fs.readFileSync(filePath));
    }
  }
  for (const relativePath of BUILD_FINGERPRINT_FILES) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    hasher.update(relativePath);
    hasher.update(fs.readFileSync(filePath));
  }
  return hasher.digest("hex").slice(0, BUILD_ID_LENGTH);
}
