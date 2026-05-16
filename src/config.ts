import * as os from "os";
import * as path from "path";

export const VIEW_TYPE = "claudeTrace.dashboard";
export const VIEW_TITLE = "Claude Trace";
export const COMMAND_OPEN_DASHBOARD = "claudeTrace.openDashboard";

export const PROJECTS_DIR =
  process.env["CLAUDE_TRACE_PROJECTS_DIR"] ??
  path.join(os.homedir(), ".claude", "projects");

export const REFRESH_TRAILING_DEBOUNCE_MS = 350;
export const REFRESH_MAX_WAIT_MS = 1500;

export const SESSION_CACHE_LRU_LIMIT = 32;

export const LIVE_POLL_INTERVAL_MS = 1000;
