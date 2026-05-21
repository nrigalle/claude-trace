export const SIDEBAR_MIN_PX = 240;
export const SIDEBAR_MAX_PX = 560;
export const SIDEBAR_DEFAULT_PX = 300;

export const clampSidebarWidth = (px: unknown): number => {
  if (typeof px !== "number" || !Number.isFinite(px)) return SIDEBAR_DEFAULT_PX;
  if (px < SIDEBAR_MIN_PX) return SIDEBAR_MIN_PX;
  if (px > SIDEBAR_MAX_PX) return SIDEBAR_MAX_PX;
  return Math.round(px);
};
