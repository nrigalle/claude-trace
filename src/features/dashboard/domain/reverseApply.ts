import type { FileChange } from "./fileEdits";

export type ComputeBeforeResult =
  | { readonly ok: true; readonly before: string }
  | { readonly ok: false; readonly reason: "drift" };

export const computeBeforeContent = (
  current: string,
  changes: readonly FileChange[],
): ComputeBeforeResult => {
  if (changes.length === 0) return { ok: true, before: current };

  for (const change of changes) {
    if (change.kind === "write") return { ok: true, before: "" };
  }

  let working = current;
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]!;
    if (change.kind !== "edit") continue;
    if (change.newString.length === 0) return { ok: false, reason: "drift" };

    const first = working.indexOf(change.newString);
    if (first < 0) return { ok: false, reason: "drift" };
    const second = working.indexOf(change.newString, first + change.newString.length);
    if (second >= 0) return { ok: false, reason: "drift" };

    working =
      working.slice(0, first) +
      change.oldString +
      working.slice(first + change.newString.length);
  }
  return { ok: true, before: working };
};
