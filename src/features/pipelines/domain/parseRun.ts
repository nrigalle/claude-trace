import {
  toBlockId,
  toPipelineId,
  toRunId,
  type BlockRun,
  type BlockSessionRecord,
  type ParallelRunState,
  type ParallelWorkerRun,
  type RunState,
  type RunStatus,
  type SessionVerdict,
  type SessionVerdictKind,
} from "./types";
import {
  BLOCK_STATUS_VALUES,
  asEnum,
  asNumber,
  asString,
  isObj,
  parsePipeline,
  serializePipeline,
} from "./parse";

const RUN_SCHEMA_VERSION = 1;

const RUN_STATUS_VALUES: readonly RunStatus[] = [
  "running",
  "paused-needs-input",
  "completed",
  "failed",
  "interrupted",
];

export const serializeRunState = (r: RunState): string =>
  JSON.stringify(
    {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: r.runId,
      pipelineId: r.pipelineId,
      name: r.name,
      pipelineSnapshot: JSON.parse(serializePipeline(r.pipelineSnapshot)),
      startedAtMs: r.startedAtMs,
      endedAtMs: r.endedAtMs,
      status: r.status,
      blocks: r.blocks.map(serializeBlockRun),
      variables: r.variables,
    },
    null,
    2,
  );

const serializeBlockRun = (b: BlockRun): unknown => ({
  blockId: b.blockId,
  status: b.status,
  sessions: b.sessions,
  parallel: b.parallel === null ? null : {
    workerRuns: b.parallel.workerRuns,
    mergerSessions: b.parallel.mergerSessions,
    mergerStatus: b.parallel.mergerStatus,
    mergerStuckReason: b.parallel.mergerStuckReason,
  },
  output: b.output,
  ...(b.logTail ? { logTail: b.logTail } : {}),
  ...(b.orchestratorSessionId ? { orchestratorSessionId: b.orchestratorSessionId } : {}),
  stuckReason: b.stuckReason,
  failureReason: b.failureReason,
  startedAtMs: b.startedAtMs,
  endedAtMs: b.endedAtMs,
});

export const parseRunState = (raw: unknown): RunState | null => {
  if (!isObj(raw)) return null;
  if (raw["schemaVersion"] !== RUN_SCHEMA_VERSION) return null;

  const runId = asString(raw["runId"]);
  const pipelineId = asString(raw["pipelineId"]);
  const startedAtMs = asNumber(raw["startedAtMs"]);
  const endedAtMs = raw["endedAtMs"] === null ? null : asNumber(raw["endedAtMs"]);
  const status = asEnum(raw["status"], RUN_STATUS_VALUES);
  if (runId === null || pipelineId === null || startedAtMs === null || status === null) return null;

  const pipeline = parsePipeline(raw["pipelineSnapshot"]);
  if (pipeline === null) return null;

  const blocksRaw = raw["blocks"];
  if (!Array.isArray(blocksRaw)) return null;

  const blocks: BlockRun[] = [];
  for (const b of blocksRaw) {
    const parsed = parseBlockRun(b);
    if (parsed === null) return null;
    blocks.push(parsed);
  }

  return {
    runId: toRunId(runId),
    pipelineId: toPipelineId(pipelineId),
    name: asString(raw["name"]) ?? "",
    pipelineSnapshot: pipeline,
    startedAtMs,
    endedAtMs,
    status,
    blocks,
    variables: parseVariables(raw["variables"]),
  };
};

const parseVariables = (raw: unknown): Record<string, string> => {
  if (!isObj(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
};

const parseBlockRun = (raw: unknown): BlockRun | null => {
  if (!isObj(raw)) return null;
  const blockId = asString(raw["blockId"]);
  const status = asEnum(raw["status"], BLOCK_STATUS_VALUES);
  const stuckReason = raw["stuckReason"] === null ? null : asString(raw["stuckReason"]);
  const failureReason = raw["failureReason"] === null ? null : asString(raw["failureReason"]);
  const startedAtMs = raw["startedAtMs"] === null ? null : asNumber(raw["startedAtMs"]);
  const endedAtMs = raw["endedAtMs"] === null ? null : asNumber(raw["endedAtMs"]);
  if (blockId === null || status === null) return null;
  const sessionsRaw = raw["sessions"];
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions: BlockSessionRecord[] = [];
  for (const s of sessionsRaw) {
    const parsed = parseBlockSession(s);
    if (parsed === null) return null;
    sessions.push(parsed);
  }
  const parallelRaw = raw["parallel"];
  let parallel: ParallelRunState | null;
  if (parallelRaw === null || parallelRaw === undefined) {
    parallel = null;
  } else {
    parallel = parseParallelRunState(parallelRaw);
    if (parallel === null) return null;
  }
  const outputRaw = raw["output"];
  const output = outputRaw === null || outputRaw === undefined ? null : asString(outputRaw);
  const logTail = typeof raw["logTail"] === "string" ? raw["logTail"] : undefined;
  const orchestratorSessionId =
    typeof raw["orchestratorSessionId"] === "string" ? raw["orchestratorSessionId"] : undefined;
  return {
    blockId: toBlockId(blockId),
    status,
    sessions,
    parallel,
    output,
    ...(logTail !== undefined ? { logTail } : {}),
    ...(orchestratorSessionId !== undefined ? { orchestratorSessionId } : {}),
    stuckReason,
    failureReason,
    startedAtMs,
    endedAtMs,
  };
};

const parseParallelRunState = (raw: unknown): ParallelRunState | null => {
  if (!isObj(raw)) return null;
  const workerRunsRaw = raw["workerRuns"];
  const mergerSessionsRaw = raw["mergerSessions"];
  const mergerStatus = asEnum(raw["mergerStatus"], BLOCK_STATUS_VALUES);
  const mergerStuckReason = raw["mergerStuckReason"] === null ? null : asString(raw["mergerStuckReason"]);
  if (!Array.isArray(workerRunsRaw) || !Array.isArray(mergerSessionsRaw) || mergerStatus === null) return null;
  const workerRuns: ParallelWorkerRun[] = [];
  for (const w of workerRunsRaw) {
    const parsed = parseParallelWorkerRun(w);
    if (parsed === null) return null;
    workerRuns.push(parsed);
  }
  const mergerSessions: BlockSessionRecord[] = [];
  for (const s of mergerSessionsRaw) {
    const parsed = parseBlockSession(s);
    if (parsed === null) return null;
    mergerSessions.push(parsed);
  }
  return { workerRuns, mergerSessions, mergerStatus, mergerStuckReason };
};

const parseParallelWorkerRun = (raw: unknown): ParallelWorkerRun | null => {
  if (!isObj(raw)) return null;
  const workerBlockId = asString(raw["workerBlockId"]);
  const status = asEnum(raw["status"], BLOCK_STATUS_VALUES);
  const stuckReason = raw["stuckReason"] === null ? null : asString(raw["stuckReason"]);
  const failureReason = raw["failureReason"] === null ? null : asString(raw["failureReason"]);
  const startedAtMs = raw["startedAtMs"] === null ? null : asNumber(raw["startedAtMs"]);
  const endedAtMs = raw["endedAtMs"] === null ? null : asNumber(raw["endedAtMs"]);
  if (workerBlockId === null || status === null) return null;
  const sessionsRaw = raw["sessions"];
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions: BlockSessionRecord[] = [];
  for (const s of sessionsRaw) {
    const parsed = parseBlockSession(s);
    if (parsed === null) return null;
    sessions.push(parsed);
  }
  return {
    workerBlockId: toBlockId(workerBlockId),
    status,
    sessions,
    stuckReason,
    failureReason,
    startedAtMs,
    endedAtMs,
  };
};

const SESSION_VERDICT_KINDS: readonly SessionVerdictKind[] = ["success", "failed", "needs-input"];

const parseSessionVerdict = (raw: unknown): SessionVerdict | null => {
  if (!isObj(raw)) return null;
  const kind = asEnum(raw["kind"], SESSION_VERDICT_KINDS);
  const detail = asString(raw["detail"]);
  if (kind === null || detail === null) return null;
  return { kind, detail };
};

const parseBlockSession = (raw: unknown): BlockSessionRecord | null => {
  if (!isObj(raw)) return null;
  const sessionId = asString(raw["sessionId"]);
  const iteration = asNumber(raw["iteration"]);
  const promptSent = asString(raw["promptSent"]);
  const summary = raw["summary"] === null ? null : asString(raw["summary"]);
  const workerOutputRaw = raw["workerOutput"];
  const workerOutput = workerOutputRaw === undefined || workerOutputRaw === null
    ? null
    : asString(workerOutputRaw);
  const verdict = parseSessionVerdict(raw["verdict"]);
  const startedAtMs = asNumber(raw["startedAtMs"]);
  const endedAtMs = raw["endedAtMs"] === null ? null : asNumber(raw["endedAtMs"]);
  if (sessionId === null || iteration === null || promptSent === null || startedAtMs === null) return null;
  return {
    sessionId,
    iteration,
    promptSent,
    summary,
    workerOutput,
    ...(verdict !== null ? { verdict } : {}),
    startedAtMs,
    endedAtMs,
  };
};

