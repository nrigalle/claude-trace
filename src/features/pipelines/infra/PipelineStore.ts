import * as fs from "fs";
import * as path from "path";
import { AUTOMATIONS_DIR } from "../../../shared/config";
import { parsePipeline, serializePipeline } from "../domain/parse";
import { fromPipelineId, type Pipeline, type PipelineId } from "../domain/types";

export class PipelineStore {
  constructor(private readonly dir: string = AUTOMATIONS_DIR) {}

  list(): readonly Pipeline[] {
    if (!fs.existsSync(this.dir)) return [];
    const entries = fs.readdirSync(this.dir, { withFileTypes: true });
    const pipelines: Pipeline[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = this.readFile(path.join(this.dir, entry.name));
      if (parsed) pipelines.push(parsed);
    }
    pipelines.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return pipelines;
  }

  get(id: PipelineId): Pipeline | null {
    return this.readFile(this.pathFor(id));
  }

  save(pipeline: Pipeline): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const final = this.pathFor(pipeline.id);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializePipeline(pipeline), "utf8");
    fs.renameSync(tmp, final);
  }

  delete(id: PipelineId): void {
    const target = this.pathFor(id);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  private pathFor(id: PipelineId): string {
    return path.join(this.dir, `${fromPipelineId(id)}.json`);
  }

  private readFile(filePath: string): Pipeline | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return parsePipeline(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
