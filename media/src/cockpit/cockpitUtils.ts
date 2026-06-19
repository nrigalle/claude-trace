export const ALL_FOLDER = "__all__";

const TERMINAL_REPORT_SEQUENCE =
  /\x1b\[[?>][0-9;]*c|\x1b\[[0-9]+;[0-9]+R|\x1b\[[0-9]+n|\x1bP[!>]\|[^\x1b]*\x1b\\/g;

export const stripTerminalReports = (data: string): string =>
  data.includes("\x1b") ? data.replace(TERMINAL_REPORT_SEQUENCE, "") : data;

export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const compactPath = (cwd: string): string => {
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
};

export const formatStartTime = (startedAtMs: number): string =>
  startedAtMs > 0
    ? new Date(startedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
