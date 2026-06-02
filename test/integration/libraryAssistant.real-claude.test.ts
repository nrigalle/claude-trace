import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { LibraryAssistant } from "../../src/features/library/infra/LibraryAssistant";
import type { AssistantContext } from "../../src/features/library/protocol";

const realClaudeOn = process.env.RUN_REAL_CLAUDE === "1";

describe.skipIf(!realClaudeOn)("LibraryAssistant — REAL claude smoke (RUN_REAL_CLAUDE=1)", () => {
  it("spawns real claude, sends a prompt, streams events, returns non-empty body within 90s", async () => {
    const ctx: AssistantContext = {
      itemKey: "skill:real-smoke",
      kind: "skill",
      name: "real-smoke",
      description: "",
      body: "",
      attachedSkills: [],
    };
    const assistant = new LibraryAssistant({
      transcriptRoot: path.join(os.homedir(), ".claude", "projects"),
    });
    let progressCount = 0;
    let lastTextChars = 0;
    const t0 = Date.now();
    const interval = setInterval(() => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[smoke] ${elapsed}s | progress events: ${progressCount} | text chars: ${lastTextChars}`);
    }, 3000);
    try {
      const result = await assistant.ask(
        ctx,
        "Write a one-paragraph description of what a code review skill should do. Be terse.",
        {
          onProgress: (events) => {
            progressCount += 1;
            lastTextChars = events
              .filter((e) => e.kind === "text")
              .reduce((n, e) => n + ((e as { text?: string }).text?.length ?? 0), 0);
          },
        },
      );
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const computed = (assistant as unknown as { items: Map<string, { transcriptPath: string; sessionId: string }> }).items.get("skill:real-smoke");
      console.log(`[smoke] DONE in ${elapsed}s | text length: ${result.text.length}`);
      console.log(`[smoke] sessionId: ${computed?.sessionId}`);
      console.log(`[smoke] computed transcriptPath: ${computed?.transcriptPath}`);
      if (computed) {
        const fs = await import("fs");
        console.log(`[smoke] file exists: ${fs.existsSync(computed.transcriptPath)}`);
      }
      console.log("=== BODY ===\n" + result.text + "\n=== END ===");
      expect(result.text.length).toBeGreaterThan(20);
    } finally {
      clearInterval(interval);
      assistant.dispose();
    }
  }, 90_000);
});
