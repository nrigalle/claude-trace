#!/usr/bin/env node
import { LibraryAssistant } from "../out/features/library/infra/LibraryAssistant.js";

const ctx = {
  itemKey: "skill:smoke-test",
  kind: "skill",
  name: "smoke-test",
  description: "",
  body: "",
  attachedSkills: [],
};

const assistant = new LibraryAssistant();
let progressCount = 0;
let lastTextChars = 0;
const t0 = Date.now();
console.log("[smoke] spawning real claude...");
const interval = setInterval(() => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[smoke] ${elapsed}s | progress events: ${progressCount} | text chars seen: ${lastTextChars}`);
}, 2000);

try {
  const result = await assistant.ask(ctx, "Write a one-paragraph description of what a code review skill should do. Be terse.", [], {
    onProgress: (events) => {
      progressCount += 1;
      lastTextChars = events
        .filter((e) => e.kind === "text")
        .reduce((n, e) => n + (e.text?.length ?? 0), 0);
    },
  });
  clearInterval(interval);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[smoke] DONE in ${elapsed}s | total progress events: ${progressCount}`);
  console.log(`[smoke] text length: ${result.text.length}`);
  console.log(`[smoke] event kinds: ${result.events.map(e => e.kind).join(", ")}`);
  console.log(`[smoke] suggested description: ${result.suggestedDescription ?? "(none)"}`);
  console.log("\n=== BODY ===");
  console.log(result.text);
  console.log("=== END ===");
  if (result.text.length === 0) {
    console.error("[smoke] FAIL: text is empty");
    process.exit(1);
  }
  console.log("\n[smoke] PASS");
} catch (err) {
  clearInterval(interval);
  console.error(`[smoke] FAIL after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, err.message);
  process.exit(1);
} finally {
  assistant.dispose();
}
