export const ALL_FOLDER = "__all__";

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
