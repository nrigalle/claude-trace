import * as fs from "fs";
import * as path from "path";
import { RUNS_DIR } from "../../../shared/config";
import { parseRunState, serializeRunState } from "../domain/parse";
import {
  fromPipelineId,
  fromRunId,
  type PipelineId,
  type RunId,
  type RunState,
} from "../domain/types";
import type { RunSummary } from "../protocol";

export type { RunSummary };

export class RunStore {
  constructor(private readonly dir: string = RUNS_DIR) {}

  list(): readonly RunSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const entries = fs.readdirSync(this.dir, { withFileTypes: true });
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = this.readFile(path.join(this.dir, entry.name, "state.json"));
      if (!state) continue;
      summaries.push({
        runId: state.runId,
        pipelineId: state.pipelineId,
        pipelineName: state.pipelineSnapshot.name,
        name: state.name,
        startedAtMs: state.startedAtMs,
        endedAtMs: state.endedAtMs,
        status: state.status,
        blockCount: state.blocks.length,
      });
    }
    summaries.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return summaries;
  }

  get(id: RunId): RunState | null {
    return this.readFile(this.statePathFor(id));
  }

  delete(id: RunId): void {
    const dir = this.dirFor(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  save(state: RunState): void {
    const runDir = this.dirFor(state.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const final = path.join(runDir, "state.json");
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeRunState(state), "utf8");
    fs.renameSync(tmp, final);
  }

  dirFor(id: RunId): string {
    return path.join(this.dir, fromRunId(id));
  }

  pipelineCwdFor(id: RunId, pipelineId: PipelineId): string {
    return path.join(this.dirFor(id), fromPipelineId(pipelineId));
  }

  private statePathFor(id: RunId): string {
    return path.join(this.dirFor(id), "state.json");
  }

  private readFile(filePath: string): RunState | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return parseRunState(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
