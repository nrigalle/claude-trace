import type { HttpHeader, HttpMethod, Interpreter } from "../domain/types";

export interface ScriptRequest {
  readonly interpreter: Interpreter;
  readonly code: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface ScriptResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: readonly HttpHeader[];
  readonly body: string | null;
  readonly signal: AbortSignal;
}

export interface HttpResult {
  readonly status: number;
  readonly body: string;
}

export interface FileWriteRequest {
  readonly cwd: string;
  readonly path: string;
  readonly content: string;
}

export interface FileReadRequest {
  readonly cwd: string;
  readonly path: string;
}

export interface DeterministicRunner {
  runScript(req: ScriptRequest): Promise<ScriptResult>;
  runHttp(req: HttpRequest): Promise<HttpResult>;
  writeFile(req: FileWriteRequest): Promise<void>;
  readFile(req: FileReadRequest): Promise<string>;
}
