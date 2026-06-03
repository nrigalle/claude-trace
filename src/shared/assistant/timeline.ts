export type TimelineEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_use"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly kind: "tool_result"; readonly toolUseId: string; readonly preview: string; readonly isError: boolean };

export interface ReplayTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly events: readonly TimelineEvent[];
}
