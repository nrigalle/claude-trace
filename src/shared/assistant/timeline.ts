// A pure, dependency-free type shared by the assistant engine (Node) and the
// webview protocols. Kept separate so the webview never pulls Node modules in.
export type TimelineEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool_use"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly kind: "tool_result"; readonly toolUseId: string; readonly preview: string; readonly isError: boolean };
