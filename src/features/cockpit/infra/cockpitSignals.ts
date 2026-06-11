import * as fs from "fs";
import * as path from "path";
import { COCKPIT_HOOKS_DIR, COCKPIT_SIGNALS_DIR } from "../../../shared/config";
import { buildCockpitHookSettings } from "./cockpitHooks";
import { logWarn } from "../../../shared/infra/traceLog";

export type AttentionReason = "stop" | "notify" | "active" | "start";

const SIGNAL_FILE = /^(.+)\.(stop|notify|active|start)$/;
const SIGNALS_POLL_INTERVAL_MS = 1000;

export const writeSessionHooks = (sessionId: string): string | null => {
  try {
    fs.mkdirSync(COCKPIT_HOOKS_DIR, { recursive: true });
    fs.mkdirSync(COCKPIT_SIGNALS_DIR, { recursive: true });
    const settings = buildCockpitHookSettings(sessionId, COCKPIT_SIGNALS_DIR);
    const file = path.join(COCKPIT_HOOKS_DIR, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(settings), "utf8");
    return file;
  } catch (err: unknown) {
    logWarn("cockpit", `Could not write the hook settings for session ${sessionId}; the done/needs-you border and bell will not fire for it`, err);
    return null;
  }
};

export const removeSessionHooks = (sessionId: string): void => {
  for (const f of [
    path.join(COCKPIT_HOOKS_DIR, `${sessionId}.json`),
    path.join(COCKPIT_SIGNALS_DIR, `${sessionId}.stop`),
    path.join(COCKPIT_SIGNALS_DIR, `${sessionId}.notify`),
    path.join(COCKPIT_SIGNALS_DIR, `${sessionId}.active`),
    path.join(COCKPIT_SIGNALS_DIR, `${sessionId}.start`),
  ]) {
    removeFile(f);
  }
};

export const watchAttentionSignals = (
  listener: (sessionId: string, reason: AttentionReason) => void,
): { dispose(): void } => {
  fs.mkdirSync(COCKPIT_SIGNALS_DIR, { recursive: true });
  let coalesce: ReturnType<typeof setTimeout> | null = null;
  const drain = (): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(COCKPIT_SIGNALS_DIR);
    } catch {
      return;
    }
    for (const name of entries) {
      const match = SIGNAL_FILE.exec(name);
      if (!match) continue;
      try {
        fs.rmSync(path.join(COCKPIT_SIGNALS_DIR, name), { force: true });
      } catch {
        continue;
      }
      listener(match[1]!, match[2] as AttentionReason);
    }
  };
  const scheduleDrain = (): void => {
    if (coalesce !== null) return;
    coalesce = setTimeout(() => {
      coalesce = null;
      drain();
    }, 30);
  };
  drain();
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  try {
    watcher = fs.watch(COCKPIT_SIGNALS_DIR, () => scheduleDrain());
    watcher.on("error", () => {
      closeWatcher(watcher);
      watcher = null;
      pollTimer = setInterval(drain, SIGNALS_POLL_INTERVAL_MS);
    });
  } catch {
    pollTimer = setInterval(drain, SIGNALS_POLL_INTERVAL_MS);
  }
  return {
    dispose: () => {
      if (coalesce !== null) clearTimeout(coalesce);
      if (pollTimer !== null) clearInterval(pollTimer);
      closeWatcher(watcher);
    },
  };
};

const removeFile = (filePath: string): void => {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    return;
  }
};

const closeWatcher = (watcher: fs.FSWatcher | null): void => {
  try {
    watcher?.close();
  } catch {
    return;
  }
};

export const saveDroppedImage = (fileName: string, dataBase64: string): string | null => {
  try {
    const dir = path.join(COCKPIT_SIGNALS_DIR, "..", "dropped-images");
    fs.mkdirSync(dir, { recursive: true });
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_") || "image.png";
    const file = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, Buffer.from(dataBase64, "base64"));
    return file;
  } catch (err: unknown) {
    logWarn("cockpit", `Could not save the dropped image "${fileName}"`, err);
    return null;
  }
};
