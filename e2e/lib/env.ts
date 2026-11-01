import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Settings for the production E2E suite. The operator token lives in e2e/.env
// (gitignored), filled in by the operator; nothing here prints it.

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DEMO_ORIGIN = process.env.DEMO_ORIGIN ?? "https://demo.gleator.com";

export function operatorToken(): string {
  const token = process.env.LAZARET_OPERATOR_TOKEN ?? "";
  if (token.length < 16) {
    throw new Error("Set LAZARET_OPERATOR_TOKEN in e2e/.env (see e2e/.env.example).");
  }
  return token;
}

/**
 * The demo resets on the hour (a fresh Ledger shard, origin re-seeded), which would
 * wipe what a run is checking. Refuse to start within a few minutes of it.
 */
export function assertClearOfReset(now = new Date()): void {
  const minute = now.getUTCMinutes();
  if (minute >= 54 || minute < 2) {
    throw new Error(`The demo resets on the hour (UTC minute is ${minute}). Run after :02.`);
  }
}
