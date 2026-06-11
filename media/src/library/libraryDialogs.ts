import type { LibrarySnapshot } from "../../../src/features/library/domain/types";
import { askName } from "../ui/modal.js";
import { normalizeName } from "./libraryHelpers.js";

type NameDialogMode = { readonly mode: "create" } | { readonly mode: "rename"; readonly currentName: string };

export const askLibraryItemName = async (
  root: HTMLElement,
  snapshot: LibrarySnapshot,
  tab: "skills" | "agents",
  dialog: NameDialogMode,
): Promise<string | null> => {
  const which = tab === "skills" ? "skill" : "agent";
  const taken = (n: string): string | null => {
    if (tab === "skills" && snapshot.skills.some((s) => (s.name as string) === n)) {
      return `A skill named "${n}" already exists.`;
    }
    if (tab === "agents" && snapshot.agents.some((a) => (a.name as string) === n)) {
      return `An agent named "${n}" already exists.`;
    }
    return null;
  };
  const raw = await askName(root, {
    title: dialog.mode === "create" ? `New ${which}` : `Rename ${which}`,
    description:
      dialog.mode === "create"
        ? "Lowercase letters, digits, and hyphens. This becomes the directory name and the command Claude uses."
        : "Lowercase letters, digits, and hyphens. Renaming also moves the files in every assigned target.",
    ...(dialog.mode === "create"
      ? { placeholder: which === "skill" ? "e.g. code-review" : "e.g. reviewer" }
      : { initial: dialog.currentName }),
    confirmLabel: dialog.mode === "create" ? `Create ${which}` : "Rename",
    validate: (value) => {
      const n = normalizeName(value);
      if (n === "") return "Name is required.";
      if (dialog.mode === "rename" && n === dialog.currentName) return "Pick a different name to rename.";
      return taken(n);
    },
  });
  if (raw === null) return null;
  const normalized = normalizeName(raw);
  if (normalized === "") return null;
  if (dialog.mode === "rename" && normalized === dialog.currentName) return null;
  return normalized;
};
