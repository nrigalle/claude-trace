import * as vscode from "vscode";
import type { SessionId } from "../domain/types";

const KEY = "claudeTrace.sessionPins.v1";

export class SessionPinStore {
  private readonly memory: Set<SessionId>;

  constructor(private readonly state: vscode.Memento) {
    this.memory = new Set(this.readPersisted());
  }

  has(id: SessionId): boolean {
    return this.memory.has(id);
  }

  async toggle(id: SessionId): Promise<boolean> {
    const isPinned = this.memory.has(id);
    if (isPinned) this.memory.delete(id);
    else this.memory.add(id);
    await this.state.update(KEY, [...this.memory]);
    return !isPinned;
  }

  private readPersisted(): readonly SessionId[] {
    const raw = this.state.get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is SessionId => typeof v === "string") as SessionId[];
  }
}
