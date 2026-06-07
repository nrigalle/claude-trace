import * as fs from "fs";
import * as path from "path";
import { PROJECTS_DIR } from "../../../shared/config";
import { extractConversationTurns, concatTextEvents } from "../../../shared/assistant/conversationTurns";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const findTranscriptFile = (sessionId: string): string | null => {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

export const readRunSessionTranscript = (sessionId: string): string => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return "";
  const file = findTranscriptFile(sessionId);
  if (!file) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const turns = extractConversationTurns(raw);
  return turns
    .map((t) => `${t.role === "assistant" ? "Claude" : "You"}:\n${concatTextEvents(t.events).trim()}`)
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
};
