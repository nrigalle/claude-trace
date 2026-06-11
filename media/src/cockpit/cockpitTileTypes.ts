export interface WindowTile {
  readonly tile: HTMLElement;
  readonly tabStrip: HTMLElement;
  readonly metaBar: HTMLElement;
  readonly termMount: HTMLElement;
  readonly resumeOverlay: HTMLElement;
  readonly bootingOverlay: HTMLElement;
  readonly status: HTMLElement;
  activeId: string;
  announced: string;
}

export type AttentionReason = "stop" | "notify" | "bell";
