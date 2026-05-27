import * as os from "os";
import * as path from "path";

export const VIEW_TYPE = "claudeTrace.dashboard";
export const VIEW_TITLE = "Claude Trace";
export const COMMAND_OPEN_DASHBOARD = "claudeTrace.openDashboard";

export const TRACE_DATA_DIR =
  process.env["CLAUDE_TRACE_DATA_DIR"] ??
  path.join(os.homedir(), ".claude-trace");

export const AUTOMATIONS_DIR = path.join(TRACE_DATA_DIR, "automations");
export const RUNS_DIR = path.join(TRACE_DATA_DIR, "runs");
export const COCKPIT_FILE = path.join(TRACE_DATA_DIR, "cockpit.json");
export const COCKPIT_SESSIONS_FILE = path.join(TRACE_DATA_DIR, "cockpit-sessions.json");
export const COCKPIT_HOOKS_DIR = path.join(TRACE_DATA_DIR, "hooks");
export const COCKPIT_SIGNALS_DIR = path.join(TRACE_DATA_DIR, "signals");

export const PROJECTS_DIR =
  process.env["CLAUDE_TRACE_PROJECTS_DIR"] ??
  path.join(os.homedir(), ".claude", "projects");

export const REFRESH_TRAILING_DEBOUNCE_MS = 350;
export const REFRESH_MAX_WAIT_MS = 1500;

export const SESSION_CACHE_LRU_LIMIT = 32;

export const LIVE_POLL_INTERVAL_MS = 1000;
