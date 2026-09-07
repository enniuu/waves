import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function createDevRuntime(baseEnv = process.env) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-dev-"));
  const env = {
    ...baseEnv,
    JWT_SECRET: randomHex(64),
    SYNC_SECRET: randomHex(),
    TURN_CREDENTIAL: randomHex(24),
    CLOUDSYNC_DB_PATH: path.join(runtimeDir, "cloudsync.db"),
  };

  return {
    env,
    runtimeDir,
    cleanup() {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
