import { spawn } from "child_process";
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
      const child = spawn(command, [flag, req.code], {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
      });
      let stdout = "";
      let stderr = "";
      const onAbort = () => child.kill("SIGTERM");
      if (req.signal.aborted) {
        child.kill("SIGTERM");
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => {
        req.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        req.signal.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
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
