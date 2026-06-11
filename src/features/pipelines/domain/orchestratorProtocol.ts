import type { OrchestratorDecision } from "./types";

const ORCHESTRATOR_SYSTEM_PROMPT = `You are a Claude Trace workflow orchestrator. Your job is to judge whether the previous worker step completed its assigned task.

You will be given the worker's task goal and the tail of its conversation (the events the worker produced while running).

Decide ONE of:
- SUCCESS: the task was accomplished
- FAILED: the worker clearly did not accomplish the task and waiting or retrying the same turn will not fix it (errors, refusal, wrong result, gave up)
- NEEDS_INPUT: the worker asked the user a question or is stuck waiting on a human
- LOOP_DONE: only for loop-evaluator calls, indicates the loop's overall goal is met and further iterations are unnecessary

Respond with EXACTLY ONE LINE in one of these formats, with NO additional text before or after:
SUCCESS: <one sentence summary of what the worker accomplished>
FAILED: <one sentence stating what went wrong>
NEEDS_INPUT: <one sentence describing what the user must clarify>
LOOP_DONE: <one sentence summary of the final loop result>`;

export const buildOrchestratorPrompt = (
  taskGoal: string,
  conversationTail: string,
): string => `${ORCHESTRATOR_SYSTEM_PROMPT}

<task_goal>
${taskGoal}
</task_goal>

<worker_conversation_tail>
${conversationTail || "(no events captured)"}
</worker_conversation_tail>

Now respond with EXACTLY ONE line matching one of the formats above.`;

export const parseOrchestratorDecision = (text: string): OrchestratorDecision => {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of lines) {
    if (line.startsWith("SUCCESS:")) {
      return { kind: "success", summary: line.slice("SUCCESS:".length).trim() };
    }
    if (line.startsWith("FAILED:")) {
      return { kind: "failed", reason: line.slice("FAILED:".length).trim() };
    }
    if (line.startsWith("NEEDS_INPUT:")) {
      return { kind: "needs-input", reason: line.slice("NEEDS_INPUT:".length).trim() };
    }
    if (line.startsWith("LOOP_DONE:")) {
      return { kind: "loop-done", summary: line.slice("LOOP_DONE:".length).trim() };
    }
  }
  return {
    kind: "needs-input",
    reason: "Orchestrator returned a malformed response. Manual review needed.",
  };
};
