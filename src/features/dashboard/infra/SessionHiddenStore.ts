import * as vscode from "vscode";
import type { SessionId } from "../domain/types";

const KEY = "claudeTrace.sessionHidden.v1";

export class SessionHiddenStore {
  private readonly memory: Set<SessionId>;

  constructor(private readonly state: vscode.Memento) {
    this.memory = new Set(this.readPersisted());
  }

  has(id: SessionId): boolean {
    return this.memory.has(id);
  }

  async hide(ids: readonly SessionId[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      if (!this.memory.has(id)) {
        this.memory.add(id);
        changed = true;
      }
    }
    if (changed) await this.state.update(KEY, [...this.memory]);
  }

  async restore(ids: readonly SessionId[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      if (this.memory.delete(id)) changed = true;
    }
    if (changed) await this.state.update(KEY, [...this.memory]);
  }

  private readPersisted(): readonly SessionId[] {
    const raw = this.state.get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is SessionId => typeof v === "string") as SessionId[];
  }
}
