export const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (ms < 3_600_000) return `${m}m ${s}s`;
  const h = Math.floor(ms / 3_600_000);
  return `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
};

export const fmtCost = (usd: number | null | undefined): string => {
  if (!usd || usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

export const fmtTokens = (n: number | null | undefined): string => {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1e6).toFixed(2)}M`;
};

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const timeShortFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const fmtDate = (ts: number): string => dateFmt.format(ts);
export const fmtTime = (ts: number): string => timeFmt.format(ts);
export const fmtTimeShort = (ts: number): string => timeShortFmt.format(ts);

export const fmtRelativeDuration = (deltaMs: number): string => {
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

export const fmtTimeAgo = (ts: number | null, now: number = Date.now()): string => {
  if (!ts) return "";
  const delta = now - ts;
  if (delta < 60_000) return "just now";
  return `${fmtRelativeDuration(delta)} ago`;
};

export const fmtPct = (n: number | null | undefined): string =>
  `${Math.round(n ?? 0)}%`;

export const shortId = (id: string, len = 12): string =>
  id.length <= len ? id : `${id.slice(0, len)}…`;
