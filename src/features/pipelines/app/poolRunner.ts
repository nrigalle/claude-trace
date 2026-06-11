import type { MapBlock, OrchestratorDecision, PoolBlock, RunState, SessionVerdict } from "../domain/types";
import { clampConcurrency, type BlockId, type RunId } from "../domain/types";
import {
  applyBlockCrashed,
  applyBlockSessionFinished,
  applyBlockSessionVerdict,
  applyBlockSpawned,
  applyDeterministicDone,
  applyDeterministicStarted,
  applyPoolOrchestrator,
  setVariable,
} from "../domain/scheduler";
import { interpolate, type InterpolationContext } from "../domain/interpolate";
import type { AutomationRunner, SpawnHandle } from "./AutomationRunner";
import type { DeterministicRunner } from "./DeterministicRunner";
import {
  BlockFailedError,
  InterruptedError,
  MAX_MAP_ITEMS,
  POOL_KEY,
  SELF_KEY,
  handleKey,
  linearMutators,
  type HandleKey,
  type PoolOrchestratorState,
  type SessionMutators,
  type SpawnRequest,
} from "./runEngineSupport";
import { assertNever } from "../../../shared/assertNever";

export interface PoolHost {
  readonly runner: AutomationRunner;
  readonly deterministic: DeterministicRunner;
  clock(): number;
  runId(): RunId;
  runCwd(): string;
  interpolationCtx(): InterpolationContext;
  signal(): AbortSignal;
  getState(): RunState;
  setState(state: RunState): void;
  persist(): void;
  trackHandle(key: HandleKey, handle: SpawnHandle): void;
  releaseHandle(blockId: BlockId, sub: string): void;
  releasePoolHandles(blockId: BlockId): void;
  runSingleTurn(
    blockId: BlockId,
    sub: string,
    req: SpawnRequest,
    mutators: SessionMutators,
  ): Promise<{ text: string }>;
}

export const runMapBlockIn = async (host: PoolHost, block: MapBlock): Promise<"success"> => {
  host.setState(applyDeterministicStarted(host.getState(), block.id, host.clock()));
  host.persist();

  const list = host.getState().variables[block.listVar] ?? "";
  const items = list.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, MAX_MAP_ITEMS);
  const mutators = linearMutators(block.id);
  const outputs: string[] = [];

  for (const item of items) {
    if (host.signal().aborted) throw new InterruptedError();
    const base = host.interpolationCtx();
    const ctx: InterpolationContext = { ...base, vars: { ...base.vars, [block.itemVar]: item } };
    const prompt = interpolate(block.prompt, ctx, { bareVars: true });
    const { text } = await host.runSingleTurn(block.id, SELF_KEY, {
        cwd: host.runCwd(),
        prompt,
        model: block.model,
        effort: block.effort,
        resumeSessionId: null,
      }, mutators);
    host.releaseHandle(block.id, SELF_KEY);
    outputs.push(text);
  }

  const combined = outputs.join("\n");
  host.setState(applyDeterministicDone(host.getState(), block.id, combined, host.clock()));
  if (block.outputVar !== null) {
    host.setState(setVariable(host.getState(), block.outputVar, combined));
  }
  host.persist();
  return "success";
};

export const runPoolBlockIn = async (host: PoolHost, block: PoolBlock): Promise<"success"> => {
  host.setState(applyDeterministicStarted(host.getState(), block.id, host.clock()));
  host.persist();

  let outputs: string[];
  let items: string[];
  const failures: { index: number; reason: string }[] = [];
  const orch: PoolOrchestratorState = { sessionId: null, queue: Promise.resolve() };
  try {
    items = (await resolvePoolItems(host, block)).slice(0, MAX_MAP_ITEMS);
    outputs = new Array(items.length).fill("");
    const concurrency = clampConcurrency(block.concurrency);

    let nextIndex = 0;
    const drainQueue = async (): Promise<void> => {
      for (;;) {
        if (host.signal().aborted) throw new InterruptedError();
        const index = nextIndex;
        if (index >= items.length) return;
        nextIndex += 1;
        outputs[index] = await runPoolItem(host, block, index, items[index]!, orch, failures);
      }
    };

    const workers = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workers }, () => drainQueue()));
    if (host.signal().aborted) throw new InterruptedError();
  } catch (err) {
    host.releasePoolHandles(block.id);
    if (err instanceof InterruptedError || host.signal().aborted) throw new InterruptedError();
    const reason = err instanceof Error ? err.message : String(err);
    host.setState(applyBlockCrashed(host.getState(), block.id, reason, host.clock()));
    host.persist();
    throw new BlockFailedError(reason);
  }

  if (failures.length > 0) {
    const reason = `${failures.length}/${items.length} pool workers failed — ${failures
      .map((f) => `#${f.index + 1}: ${f.reason}`)
      .join(" · ")}`;
    host.setState(applyBlockCrashed(host.getState(), block.id, reason, host.clock()));
    host.persist();
    throw new BlockFailedError(reason);
  }

  const combined = outputs.join("\n");
  host.setState(applyDeterministicDone(host.getState(), block.id, combined, host.clock()));
  if (block.outputVar !== null) {
    host.setState(setVariable(host.getState(), block.outputVar, combined));
  }
  host.persist();
  return "success";
};

const runPoolItem = async (
  host: PoolHost,
  block: PoolBlock,
  index: number,
  item: string,
  orch: PoolOrchestratorState,
  failures: { index: number; reason: string }[],
): Promise<string> => {
  const sub = `${POOL_KEY}#${index}`;
  const base = host.interpolationCtx();
  const ctx: InterpolationContext = { ...base, vars: { ...base.vars, [block.itemVar]: item } };
  const prompt = interpolate(block.prompt, ctx, { bareVars: true });
  const turnStartMs = host.clock();

  let handle: SpawnHandle;
  try {
    handle = await host.runner.spawn({
        runId: host.runId(),
        blockId: block.id,
        cwd: host.runCwd(),
        prompt,
        model: block.model,
        effort: block.effort,
        resumeSessionId: null,
        signal: host.signal(),
      });
  } catch (err) {
    throw new BlockFailedError(err instanceof Error ? err.message : String(err));
  }
  host.trackHandle(handleKey(block.id, sub), handle);
  host.setState(applyBlockSpawned(host.getState(), block.id, handle.sessionId, prompt, host.clock()));
  host.persist();

  const turnEnd = await handle.waitForTurnEnd(turnStartMs, host.signal());
  if (turnEnd === "aborted") {
    host.releaseHandle(block.id, sub);
    throw new InterruptedError();
  }

  const text = handle.readLastAssistantText();
  host.setState(applyBlockSessionFinished(host.getState(), block.id, handle.sessionId, text, host.clock()));
  host.persist();
  host.releaseHandle(block.id, sub);

  const recordVerdict = (verdict: SessionVerdict): void => {
    host.setState(applyBlockSessionVerdict(host.getState(), block.id, handle.sessionId, verdict));
    host.persist();
    if (verdict.kind !== "success") failures.push({ index, reason: verdict.detail });
  };

  if (turnEnd === "terminal-closed" || turnEnd === "process-exited") {
    recordVerdict({
        kind: "failed",
        detail:
        turnEnd === "process-exited"
        ? "The Claude process exited before finishing this item."
        : "Terminal was closed before Claude finished responding.",
      });
    return text;
  }
  if (turnEnd === "notified") {
    recordVerdict({ kind: "needs-input", detail: "Hit a permission prompt; pool workers run unattended." });
    return text;
  }

  const decision = await judgePoolItem(host, block, prompt, handle.jsonlPath, orch);
  if (host.signal().aborted) throw new InterruptedError();
  switch (decision.kind) {
    case "success":
    case "loop-done":
    recordVerdict({ kind: "success", detail: decision.summary });
    break;
    case "failed":
    recordVerdict({ kind: "failed", detail: decision.reason });
    break;
    case "needs-input":
    recordVerdict({ kind: "needs-input", detail: decision.reason });
    break;
    default:
    assertNever(decision);
  }
  return text;
};

const judgePoolItem = (
  host: PoolHost,
  block: PoolBlock,
  taskGoal: string,
  workerJsonlPath: string,
  orch: PoolOrchestratorState,
): Promise<OrchestratorDecision> => {
  const judged = orch.queue.then(async () => {
      const outcome = await host.runner.judge({
          runId: host.runId(),
          blockId: block.id,
          cwd: host.runCwd(),
          taskGoal,
          workerJsonlPath,
          resumeSessionId: null,
          signal: host.signal(),
        });
      orch.sessionId = outcome.orchestratorSessionId ?? orch.sessionId;
      if (orch.sessionId !== null) {
        host.setState(applyPoolOrchestrator(host.getState(), block.id, orch.sessionId));
        host.persist();
      }
      return outcome.decision;
    });
  orch.queue = judged.then(
    () => undefined,
    () => undefined,
  );
  return judged;
};

const resolvePoolItems = async (host: PoolHost, block: PoolBlock): Promise<string[]> => {
  let listText: string;
  if (block.listVar.includes("${")) {
      listText = interpolate(block.listVar, host.interpolationCtx(), { bareVars: true });
    } else if (block.listVar in host.getState().variables) {
      listText = host.getState().variables[block.listVar] ?? "";
    } else {
      listText = await host.deterministic.readFile({ cwd: host.runCwd(), path: block.listVar });
    }
    return listText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  };
