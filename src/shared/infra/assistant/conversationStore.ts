import * as fs from "fs";
import * as path from "path";

export interface StoredConversation {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly mode?: string;
}

const MAX_PER_KEY = 50;

const isStoredConversation = (value: unknown): value is StoredConversation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec["id"] === "string" &&
    typeof rec["sessionId"] === "string" &&
    typeof rec["cwd"] === "string" &&
    typeof rec["title"] === "string" &&
    typeof rec["createdAtMs"] === "number" &&
    Number.isFinite(rec["createdAtMs"]) &&
    typeof rec["updatedAtMs"] === "number" &&
    Number.isFinite(rec["updatedAtMs"]) &&
    (rec["mode"] === undefined || typeof rec["mode"] === "string");
};

const newestFirst = (rows: readonly StoredConversation[]): StoredConversation[] =>
  [...rows].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

const capRows = (rows: readonly StoredConversation[]): StoredConversation[] =>
  newestFirst(rows).slice(0, MAX_PER_KEY);

export class ConversationStore {
  constructor(private readonly file: string) {}

  list(key: string): readonly StoredConversation[] {
    const rows = this.readAll()[key] ?? [];
    return newestFirst(rows);
  }

  get(key: string, conversationId: string): StoredConversation | null {
    return this.list(key).find((c) => c.id === conversationId) ?? null;
  }

  upsert(key: string, conversation: StoredConversation): void {
    const all = this.readAll();
    const rows = all[key] ?? [];
    const next = rows.filter((c) => c.id !== conversation.id);
    next.push(conversation);
    all[key] = capRows(next);
    this.writeAll(all);
  }

  rename(key: string, conversationId: string, title: string): void {
    const existing = this.get(key, conversationId);
    if (!existing) return;
    this.upsert(key, { ...existing, title });
  }

  delete(key: string, conversationId: string): void {
    const all = this.readAll();
    const rows = all[key];
    if (!rows) return;
    const next = rows.filter((c) => c.id !== conversationId);
    if (next.length > 0) all[key] = next;
    else delete all[key];
    this.writeAll(all);
  }

  move(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const all = this.readAll();
    const rows = all[oldKey];
    if (!rows || rows.length === 0) return;
    delete all[oldKey];
    const movedIds = new Set(rows.map((r) => r.id));
    all[newKey] = capRows([...(all[newKey] ?? []).filter((r) => !movedIds.has(r.id)), ...rows]);
    this.writeAll(all);
  }

  dropKey(key: string): void {
    const all = this.readAll();
    if (!(key in all)) return;
    delete all[key];
    this.writeAll(all);
  }

  private readAll(): Record<string, StoredConversation[]> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const out: Record<string, StoredConversation[]> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            const rows = value.filter(isStoredConversation);
            if (rows.length > 0) out[key] = capRows(rows);
          }
        }
        return out;
      }
    } catch {
      return {};
    }
    return {};
  }

  private writeAll(all: Record<string, StoredConversation[]>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      return;
    }
  }
}
