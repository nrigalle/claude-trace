import {
  clampConcurrency,
  toBlockId,
  toPipelineId,
  toRunId,
  type Block,
  type BlockRun,
  type BlockSessionRecord,
  type BlockStatus,
  type ApprovalBlock,
  type ConditionBlock,
  type EffortLevel,
  type EvaluatorBlock,
  type FileBlock,
  type FileOperation,
  type HttpBlock,
  type HttpHeader,
  type HttpMethod,
  type InputBlock,
  type InputColumn,
  type InputColumnType,
  type Interpreter,
  type LlmBlock,
  type LoopBlock,
  type MapBlock,
  type ParallelBlock,
  type PoolBlock,
  type ReduceBlock,
  type ReduceMode,
  type ScriptBlock,
  type WaitBlock,
  type ParallelRunState,
  type ParallelWorkerRun,
  type Pipeline,
  type RunState,
  type RunStatus,
  type ScheduleRecurrence,
  type Trigger,
  type WorkerBlock,
} from "./types";
import { MODEL_CHOICES, type ModelChoice } from "../../../shared/models";
import { assertNever } from "../../../shared/assertNever";

export const PIPELINE_SCHEMA_VERSION = 1;
const RUN_SCHEMA_VERSION = 1;

const MODEL_VALUES: readonly ModelChoice[] = MODEL_CHOICES;

const EFFORT_VALUES: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

const BLOCK_STATUS_VALUES: readonly BlockStatus[] = [
  "pending",
  "running",
  "judging",
  "done",
  "skipped",
  "stuck",
  "failed",
  "interrupted",
];

const INTERPRETER_VALUES: readonly Interpreter[] = ["bash", "sh", "python", "node"];
const INPUT_COLUMN_TYPE_VALUES: readonly InputColumnType[] = ["text", "url", "enum"];
const HTTP_METHOD_VALUES: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FILE_OP_VALUES: readonly FileOperation[] = ["write", "read"];
const REDUCE_MODE_VALUES: readonly ReduceMode[] = ["concat", "llm"];

const RUN_STATUS_VALUES: readonly RunStatus[] = [
  "running",
  "paused-needs-input",
  "completed",
  "failed",
  "interrupted",
];

export const serializePipeline = (p: Pipeline): string =>
  JSON.stringify(
    {
      schemaVersion: PIPELINE_SCHEMA_VERSION,
      id: p.id,
      name: p.name,
      createdAtMs: p.createdAtMs,
      updatedAtMs: p.updatedAtMs,
      blocks: p.blocks.map(serializeBlock),
      triggers: p.triggers,
    },
    null,
    2,
  );

const serializeBlock = (b: Block): unknown => {
  switch (b.kind) {
    case "worker":
      return serializeWorker(b);
    case "parallel":
      return {
        id: b.id,
        kind: "parallel",
        name: b.name,
        mergerGoal: b.mergerGoal,
        mergerModel: b.mergerModel,
        workers: b.workers.map(serializeWorker),
      };
    case "loop":
      return {
        id: b.id,
        kind: "loop",
        name: b.name,
        loopBackToBlockId: b.loopBackToBlockId,
        goal: b.goal,
        maxIterations: b.maxIterations,
        evaluatorModel: b.evaluatorModel,
      };
    case "script":
      return {
        id: b.id,
        kind: "script",
        name: b.name,
        interpreter: b.interpreter,
        code: b.code,
        outputVar: b.outputVar,
      };
    case "http":
      return {
        id: b.id,
        kind: "http",
        name: b.name,
        method: b.method,
        url: b.url,
        headers: b.headers.map((h) => ({ name: h.name, value: h.value })),
        body: b.body,
        outputVar: b.outputVar,
      };
    case "file":
      return {
        id: b.id,
        kind: "file",
        name: b.name,
        operation: b.operation,
        path: b.path,
        content: b.content,
        outputVar: b.outputVar,
      };
    case "condition":
      return {
        id: b.id,
        kind: "condition",
        name: b.name,
        expression: b.expression,
        skipToBlockId: b.skipToBlockId,
      };
    case "wait":
      return {
        id: b.id,
        kind: "wait",
        name: b.name,
        durationMs: b.durationMs,
      };
    case "reduce":
      return {
        id: b.id,
        kind: "reduce",
        name: b.name,
        inputVar: b.inputVar,
        mode: b.mode,
        separator: b.separator,
        mergerGoal: b.mergerGoal,
        mergerModel: b.mergerModel,
        outputVar: b.outputVar,
      };
    case "llm":
      return {
        id: b.id,
        kind: "llm",
        name: b.name,
        prompt: b.prompt,
        model: b.model,
        effort: b.effort,
        outputVar: b.outputVar,
      };
    case "evaluator":
      return {
        id: b.id,
        kind: "evaluator",
        name: b.name,
        goal: b.goal,
        evaluatorModel: b.evaluatorModel,
      };
    case "map":
      return {
        id: b.id,
        kind: "map",
        name: b.name,
        listVar: b.listVar,
        itemVar: b.itemVar,
        prompt: b.prompt,
        model: b.model,
        effort: b.effort,
        outputVar: b.outputVar,
      };
    case "pool":
      return {
        id: b.id,
        kind: "pool",
        name: b.name,
        listVar: b.listVar,
        itemVar: b.itemVar,
        concurrency: b.concurrency,
        prompt: b.prompt,
        model: b.model,
        effort: b.effort,
        outputVar: b.outputVar,
      };
    case "approval":
      return {
        id: b.id,
        kind: "approval",
        name: b.name,
        message: b.message,
      };
    case "input":
      return {
        id: b.id,
        kind: "input",
        name: b.name,
        message: b.message,
        columns: b.columns.map((c) => ({
          key: c.key,
          label: c.label,
          type: c.type,
          options: c.options,
          required: c.required,
          help: c.help,
        })),
        outputVar: b.outputVar,
      };
    default:
      return assertNever(b);
  }
};

const serializeWorker = (b: WorkerBlock): unknown => ({
  id: b.id,
  kind: "worker",
  name: b.name,
  prompt: b.prompt,
  model: b.model,
  effort: b.effort,
  ...(b.restartEachIteration ? { restartEachIteration: true } : {}),
});

export const parsePipeline = (raw: unknown): Pipeline | null => {
  if (!isObj(raw)) return null;
  if (raw["schemaVersion"] !== PIPELINE_SCHEMA_VERSION) return null;

  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const createdAtMs = asNumber(raw["createdAtMs"]);
  const updatedAtMs = asNumber(raw["updatedAtMs"]);
  if (id === null || name === null || createdAtMs === null || updatedAtMs === null) return null;

  const blocksRaw = raw["blocks"];
  if (!Array.isArray(blocksRaw)) return null;

  const blocks: Block[] = [];
  for (const b of blocksRaw) {
    const block = parseBlock(b);
    if (block === null) return null;
    blocks.push(block);
  }

  return {
    id: toPipelineId(id),
    name,
    createdAtMs,
    updatedAtMs,
    blocks,
    triggers: parseTriggers(raw["triggers"]),
  };
};

const parseTriggers = (raw: unknown): readonly Trigger[] => {
  if (!Array.isArray(raw)) return [];
  const triggers: Trigger[] = [];
  for (const t of raw) {
    if (!isObj(t)) continue;
    const enabled = t["enabled"] !== false;
    if (t["kind"] === "schedule") {
      let recurrence = parseRecurrence(t["recurrence"]);
      if (!recurrence) {
        const intervalMs = asNumber(t["intervalMs"]);
        if (intervalMs !== null && intervalMs > 0) recurrence = { type: "interval", everyMs: intervalMs };
      }
      if (recurrence) triggers.push({ kind: "schedule", enabled, recurrence });
    } else if (t["kind"] === "webhook") {
      const token = asString(t["token"]);
      if (token !== null) triggers.push({ kind: "webhook", token, enabled });
    }
  }
  return triggers;
};

const clampMinute = (m: number): number => Math.min(1439, Math.max(0, Math.round(m)));

const parseRecurrence = (raw: unknown): ScheduleRecurrence | null => {
  if (!isObj(raw)) return null;
  const atMinute = asNumber(raw["atMinute"]);
  switch (raw["type"]) {
    case "interval": {
      const everyMs = asNumber(raw["everyMs"]);
      return everyMs !== null && everyMs > 0 ? { type: "interval", everyMs } : null;
    }
    case "daily":
      return atMinute !== null ? { type: "daily", atMinute: clampMinute(atMinute) } : null;
    case "weekly": {
      const weekdays = Array.isArray(raw["weekdays"])
        ? raw["weekdays"].filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      return atMinute !== null && weekdays.length > 0
        ? { type: "weekly", weekdays, atMinute: clampMinute(atMinute) }
        : null;
    }
    case "monthly": {
      const day = asNumber(raw["day"]);
      return atMinute !== null && day !== null && Number.isInteger(day) && day >= 1 && day <= 31
        ? { type: "monthly", day, atMinute: clampMinute(atMinute) }
        : null;
    }
    default:
      return null;
  }
};

const parseBlock = (raw: unknown): Block | null => {
  if (!isObj(raw)) return null;
  switch (raw["kind"]) {
    case "worker":
      return parseWorker(raw);
    case "parallel":
      return parseParallel(raw);
    case "loop":
      return parseLoop(raw);
    case "script":
      return parseScript(raw);
    case "http":
      return parseHttp(raw);
    case "file":
      return parseFile(raw);
    case "condition":
      return parseCondition(raw);
    case "wait":
      return parseWait(raw);
    case "reduce":
      return parseReduce(raw);
    case "llm":
      return parseLlm(raw);
    case "evaluator":
      return parseEvaluator(raw);
    case "map":
      return parseMap(raw);
    case "pool":
      return parsePool(raw);
    case "approval":
      return parseApproval(raw);
    case "input":
      return parseInput(raw);
    default:
      return null;
  }
};

const parseApproval = (raw: Record<string, unknown>): ApprovalBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const message = asString(raw["message"]);
  if (id === null || name === null || message === null) return null;
  return { id: toBlockId(id), kind: "approval", name, message };
};

const parseInput = (raw: Record<string, unknown>): InputBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const message = asString(raw["message"]);
  const outputVar = asNullableVarName(raw["outputVar"]);
  const columnsRaw = raw["columns"];
  if (id === null || name === null || message === null || outputVar === undefined) return null;
  if (!Array.isArray(columnsRaw)) return null;
  const columns: InputColumn[] = [];
  for (const c of columnsRaw) {
    if (!isObj(c)) return null;
    const key = asString(c["key"]);
    const label = asString(c["label"]);
    const type = asEnum(c["type"], INPUT_COLUMN_TYPE_VALUES);
    if (key === null || label === null || type === null) return null;
    const optionsRaw = c["options"];
    const options: string[] = [];
    if (Array.isArray(optionsRaw)) {
      for (const o of optionsRaw) {
        const s = asString(o);
        if (s !== null) options.push(s);
      }
    }
    const required = c["required"] === true;
    const help = c["help"] === null || c["help"] === undefined ? null : asString(c["help"]);
    columns.push({ key, label, type, options, required, help });
  }
  return { id: toBlockId(id), kind: "input", name, message, columns, outputVar };
};

const parseLlm = (raw: Record<string, unknown>): LlmBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const prompt = asString(raw["prompt"]);
  const model = asEnum(raw["model"], MODEL_VALUES);
  const effort = asEnum(raw["effort"], EFFORT_VALUES);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || prompt === null || model === null || effort === null || outputVar === undefined) {
    return null;
  }
  return { id: toBlockId(id), kind: "llm", name, prompt, model, effort, outputVar };
};

const parseEvaluator = (raw: Record<string, unknown>): EvaluatorBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const goal = asString(raw["goal"]);
  const evaluatorModel = asEnum(raw["evaluatorModel"], MODEL_VALUES);
  if (id === null || name === null || goal === null || evaluatorModel === null) return null;
  return { id: toBlockId(id), kind: "evaluator", name, goal, evaluatorModel };
};

const parseMap = (raw: Record<string, unknown>): MapBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const listVar = asString(raw["listVar"]);
  const itemVar = asString(raw["itemVar"]);
  const prompt = asString(raw["prompt"]);
  const model = asEnum(raw["model"], MODEL_VALUES);
  const effort = asEnum(raw["effort"], EFFORT_VALUES);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || listVar === null || itemVar === null || prompt === null) return null;
  if (model === null || effort === null || outputVar === undefined) return null;
  return { id: toBlockId(id), kind: "map", name, listVar, itemVar, prompt, model, effort, outputVar };
};

const parsePool = (raw: Record<string, unknown>): PoolBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const listVar = asString(raw["listVar"]);
  const itemVar = asString(raw["itemVar"]);
  const concurrency = asNumber(raw["concurrency"]);
  const prompt = asString(raw["prompt"]);
  const model = asEnum(raw["model"], MODEL_VALUES);
  const effort = asEnum(raw["effort"], EFFORT_VALUES);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || listVar === null || itemVar === null || prompt === null) return null;
  if (concurrency === null || model === null || effort === null || outputVar === undefined) return null;
  return {
    id: toBlockId(id),
    kind: "pool",
    name,
    listVar,
    itemVar,
    concurrency: clampConcurrency(concurrency),
    prompt,
    model,
    effort,
    outputVar,
  };
};

const parseCondition = (raw: Record<string, unknown>): ConditionBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const expression = asString(raw["expression"]);
  const targetRaw = raw["skipToBlockId"];
  const skipToBlockId =
    targetRaw === null || targetRaw === undefined
      ? null
      : typeof targetRaw === "string"
        ? toBlockId(targetRaw)
        : undefined;
  if (id === null || name === null || expression === null || skipToBlockId === undefined) return null;
  return { id: toBlockId(id), kind: "condition", name, expression, skipToBlockId };
};

const parseWait = (raw: Record<string, unknown>): WaitBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const durationMs = asNumber(raw["durationMs"]);
  if (id === null || name === null || durationMs === null) return null;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  return { id: toBlockId(id), kind: "wait", name, durationMs };
};

const parseReduce = (raw: Record<string, unknown>): ReduceBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const inputVar = asString(raw["inputVar"]);
  const mode = asEnum(raw["mode"], REDUCE_MODE_VALUES);
  const separator = asString(raw["separator"]);
  const mergerGoal = asString(raw["mergerGoal"]);
  const mergerModel = asEnum(raw["mergerModel"], MODEL_VALUES);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || inputVar === null || mode === null || separator === null) return null;
  if (mergerGoal === null || mergerModel === null || outputVar === undefined) return null;
  return { id: toBlockId(id), kind: "reduce", name, inputVar, mode, separator, mergerGoal, mergerModel, outputVar };
};

const asNullableVarName = (v: unknown): string | null | undefined => {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : undefined;
};

const parseScript = (raw: Record<string, unknown>): ScriptBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const interpreter = asEnum(raw["interpreter"], INTERPRETER_VALUES);
  const code = asString(raw["code"]);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || interpreter === null || code === null || outputVar === undefined) {
    return null;
  }
  return { id: toBlockId(id), kind: "script", name, interpreter, code, outputVar };
};

const parseHttp = (raw: Record<string, unknown>): HttpBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const method = asEnum(raw["method"], HTTP_METHOD_VALUES);
  const url = asString(raw["url"]);
  const body = raw["body"] === null || raw["body"] === undefined ? null : asString(raw["body"]);
  const outputVar = asNullableVarName(raw["outputVar"]);
  const headersRaw = raw["headers"];
  if (id === null || name === null || method === null || url === null || outputVar === undefined) {
    return null;
  }
  if (!Array.isArray(headersRaw)) return null;
  const headers: HttpHeader[] = [];
  for (const h of headersRaw) {
    if (!isObj(h)) return null;
    const hName = asString(h["name"]);
    const hValue = asString(h["value"]);
    if (hName === null || hValue === null) return null;
    headers.push({ name: hName, value: hValue });
  }
  return { id: toBlockId(id), kind: "http", name, method, url, headers, body, outputVar };
};

const parseFile = (raw: Record<string, unknown>): FileBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const operation = asEnum(raw["operation"], FILE_OP_VALUES);
  const path = asString(raw["path"]);
  const content = asString(raw["content"]);
  const outputVar = asNullableVarName(raw["outputVar"]);
  if (id === null || name === null || operation === null || path === null || content === null || outputVar === undefined) {
    return null;
  }
  return { id: toBlockId(id), kind: "file", name, operation, path, content, outputVar };
};

const parseWorker = (raw: Record<string, unknown>): WorkerBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const prompt = asString(raw["prompt"]);
  const model = asEnum(raw["model"], MODEL_VALUES);
  const effort = asEnum(raw["effort"], EFFORT_VALUES);
  if (id === null || name === null || prompt === null || model === null || effort === null) {
    return null;
  }
  const restartEachIteration = raw["restartEachIteration"] === true ? true : undefined;
  return { id: toBlockId(id), kind: "worker", name, prompt, model, effort, restartEachIteration };
};

const parseParallel = (raw: Record<string, unknown>): ParallelBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const mergerGoal = asString(raw["mergerGoal"]);
  const mergerModel = asEnum(raw["mergerModel"], MODEL_VALUES);
  const workersRaw = raw["workers"];
  if (id === null || name === null || mergerGoal === null || mergerModel === null) return null;
  if (!Array.isArray(workersRaw)) return null;
  const workers: WorkerBlock[] = [];
  for (const w of workersRaw) {
    if (!isObj(w)) return null;
    const parsed = parseWorker(w);
    if (parsed === null) return null;
    workers.push(parsed);
  }
  return { id: toBlockId(id), kind: "parallel", name, workers, mergerGoal, mergerModel };
};

const parseLoop = (raw: Record<string, unknown>): LoopBlock | null => {
  const id = asString(raw["id"]);
  const name = asString(raw["name"]);
  const maxIterations = asNumber(raw["maxIterations"]);
  const goal = asString(raw["goal"]);
  const evaluatorModel = asEnum(raw["evaluatorModel"], MODEL_VALUES);
  const targetRaw = raw["loopBackToBlockId"];
  const loopBackToBlockId =
    targetRaw === null ? null : (typeof targetRaw === "string" ? toBlockId(targetRaw) : undefined);
  if (id === null || name === null || maxIterations === null || goal === null || evaluatorModel === null) return null;
  if (loopBackToBlockId === undefined) return null;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) return null;
  return {
    id: toBlockId(id),
    kind: "loop",
    name,
    loopBackToBlockId,
    goal,
    maxIterations,
    evaluatorModel,
  };
};

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
  return {
    blockId: toBlockId(blockId),
    status,
    sessions,
    parallel,
    output,
    ...(logTail !== undefined ? { logTail } : {}),
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
  const startedAtMs = asNumber(raw["startedAtMs"]);
  const endedAtMs = raw["endedAtMs"] === null ? null : asNumber(raw["endedAtMs"]);
  if (sessionId === null || iteration === null || promptSent === null || startedAtMs === null) return null;
  return { sessionId, iteration, promptSent, summary, workerOutput, startedAtMs, endedAtMs };
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const asEnum = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;
