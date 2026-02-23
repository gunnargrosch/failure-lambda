import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ConfigSource } from "./store.js";

const SETTINGS_PATH = join(homedir(), ".failure-lambda.json");

export interface SavedProfile {
  region: string;
  source: ConfigSource;
}

export interface Settings {
  profiles: Record<string, SavedProfile>;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { profiles: parsed.profiles ?? {} };
  } catch {
    return { profiles: {} };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
