import * as vscode from "vscode";
import type { SessionId } from "../../domain/types";

const KEY = "claudeTrace.sessionNames.v1";

type NameMap = Record<string, string>;

export class SessionNameStore {
  constructor(private readonly state: vscode.Memento) {}

  get(id: SessionId): string | null {
    const map = this.state.get<NameMap>(KEY) ?? {};
    const value = map[id];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async set(id: SessionId, name: string | null): Promise<void> {
    const map: NameMap = { ...(this.state.get<NameMap>(KEY) ?? {}) };
    if (name === null || name.length === 0) {
      delete map[id];
    } else {
      map[id] = name;
    }
    await this.state.update(KEY, map);
  }
}
