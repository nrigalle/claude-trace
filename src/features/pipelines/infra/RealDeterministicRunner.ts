import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { assertNever } from "../../../shared/assertNever";

import type {
  DeterministicRunner,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResult,
  ScriptRequest,
  ScriptResult,
} from "../app/DeterministicRunner";
import type { Interpreter } from "../domain/types";

const MAX_SCRIPT_OUTPUT_BYTES = 5 * 1024 * 1024;
const SCRIPT_KILL_GRACE_MS = 3000;

const interpreterCommand = (interpreter: Interpreter): { command: string; flag: string } => {
  switch (interpreter) {
    case "bash":
      return { command: "bash", flag: "-c" };
    case "sh":
      return { command: "sh", flag: "-c" };
    case "python":
      return { command: process.platform === "win32" ? "python" : "python3", flag: "-c" };
    case "node":
      return { command: process.execPath, flag: "-e" };
    default:
      return assertNever(interpreter);
  }
};

const resolveInWorkspace = (cwd: string, relative: string): string => {
  const resolved = path.resolve(cwd, relative);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`File path "${relative}" escapes the run workspace.`);
  }
  return resolved;
};

export class RealDeterministicRunner implements DeterministicRunner {
  runScript(req: ScriptRequest): Promise<ScriptResult> {
    const { command, flag } = interpreterCommand(req.interpreter);
    return new Promise<ScriptResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, [flag, req.code], {
          cwd: req.cwd,
          env: { ...process.env, ...req.env },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stdout = "";
      let stderr = "";
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const stop = (): void => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { void 0; }
        }, SCRIPT_KILL_GRACE_MS);
      };
      const onAbort = (): void => stop();
      if (req.signal.aborted) stop();
      else req.signal.addEventListener("abort", onAbort, { once: true });
      const append = (cur: string, d: Buffer): string =>
        cur.length >= MAX_SCRIPT_OUTPUT_BYTES ? cur : (cur + d.toString()).slice(0, MAX_SCRIPT_OUTPUT_BYTES);
      child.stdout.on("data", (d: Buffer) => { stdout = append(stdout, d); });
      child.stderr.on("data", (d: Buffer) => { stderr = append(stderr, d); });
      const cleanup = (): void => {
        req.signal.removeEventListener("abort", onAbort);
        if (killTimer !== null) clearTimeout(killTimer);
      };
      child.on("error", (err) => { cleanup(); reject(err); });
      child.on("close", (code) => { cleanup(); resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    });
  }

  async runHttp(req: HttpRequest): Promise<HttpResult> {
    const headers: Record<string, string> = {};
    for (const h of req.headers) headers[h.name] = h.value;
    const response = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.body === null ? undefined : req.body,
      signal: req.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  }

  async writeFile(req: FileWriteRequest): Promise<void> {
    const target = resolveInWorkspace(req.cwd, req.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, req.content, "utf8");
  }

  async readFile(req: FileReadRequest): Promise<string> {
    return fs.promises.readFile(resolveInWorkspace(req.cwd, req.path), "utf8");
  }
}
