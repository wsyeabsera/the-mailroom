import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Config = { url: string; credential: string };

// Computed on each call so tests can change HOME.
const dir = () => path.join(os.homedir(), ".mailroom");
export const configPath = () => path.join(dir(), "config.json");
const statePath = () => path.join(dir(), "state.json");

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir(), 0o700);
}

function writePrivate(file: string, data: unknown) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function saveConfig(c: Config) {
  if (!c.credential.startsWith("mrd_")) throw new Error("That is not a daemon credential (it should start with mrd_).");
  const u = new URL(c.url); // throws on a bad URL
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The Hub URL must start with http:// or https://");
  writePrivate(configPath(), { url: c.url.replace(/\/+$/, ""), credential: c.credential });
}

export function loadConfig(): Config | null {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return typeof c.url === "string" && typeof c.credential === "string" ? c : null;
  } catch {
    return null;
  }
}

export function deleteConfig(): boolean {
  try {
    fs.unlinkSync(configPath());
    return true;
  } catch {
    return false;
  }
}

export function loadLastSeq(): number {
  try {
    const n = JSON.parse(fs.readFileSync(statePath(), "utf8")).last_seq;
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function saveLastSeq(last_seq: number) {
  writePrivate(statePath(), { last_seq });
}
