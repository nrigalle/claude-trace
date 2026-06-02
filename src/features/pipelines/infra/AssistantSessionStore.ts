import * as fs from "fs";
import * as path from "path";
import { TRACE_DATA_DIR } from "../../../shared/config";
import { fromPipelineId, type PipelineId } from "../domain/types";

export interface AssistantConversation {
  readonly id: string;        // our stable conversation id (the engine key)
  readonly sessionId: string; // the claude session id, for --resume
  readonly cwd: string;
  readonly title: string;     // short label derived from the first user message
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

// Persists, per pipeline, every assistant conversation so the chats survive a
// window reload: the user can list past chats for a workflow, resume any of them
// (--resume) and keep talking. Stored as { [pipelineId]: AssistantConversation[] }.
export class AssistantSessionStore {
  constructor(
    private readonly file: string = path.join(TRACE_DATA_DIR, "pipeline-assistant", "sessions.json"),
  ) {}

  list(pipelineId: PipelineId): readonly AssistantConversation[] {
    const all = this.readAll();
    const rows = all[fromPipelineId(pipelineId)] ?? [];
    return [...rows].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  get(pipelineId: PipelineId, conversationId: string): AssistantConversation | null {
    return this.list(pipelineId).find((c) => c.id === conversationId) ?? null;
  }

  upsert(pipelineId: PipelineId, conversation: AssistantConversation): void {
    const all = this.readAll();
    const key = fromPipelineId(pipelineId);
    const rows = all[key] ?? [];
    const next = rows.filter((c) => c.id !== conversation.id);
    next.push(conversation);
    all[key] = next;
    this.writeAll(all);
  }

  rename(pipelineId: PipelineId, conversationId: string, title: string): void {
    const existing = this.get(pipelineId, conversationId);
    if (!existing) return;
    this.upsert(pipelineId, { ...existing, title });
  }

  delete(pipelineId: PipelineId, conversationId: string): void {
    const all = this.readAll();
    const key = fromPipelineId(pipelineId);
    const rows = all[key];
    if (!rows) return;
    const next = rows.filter((c) => c.id !== conversationId);
    if (next.length > 0) all[key] = next;
    else delete all[key];
    this.writeAll(all);
  }

  private readAll(): Record<string, AssistantConversation[]> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const out: Record<string, AssistantConversation[]> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (Array.isArray(value)) out[key] = value as AssistantConversation[];
        }
        return out;
      }
    } catch {
      return {};
    }
    return {};
  }

  private writeAll(all: Record<string, AssistantConversation[]>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      return;
    }
  }
}
