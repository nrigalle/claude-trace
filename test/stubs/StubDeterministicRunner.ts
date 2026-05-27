import type {
  DeterministicRunner,
  FileReadRequest,
  FileWriteRequest,
  HttpRequest,
  HttpResult,
  ScriptRequest,
  ScriptResult,
} from "../../src/features/pipelines/app/DeterministicRunner";

export class StubDeterministicRunner implements DeterministicRunner {
  readonly scriptCalls: ScriptRequest[] = [];
  readonly httpCalls: HttpRequest[] = [];
  readonly fileWrites: FileWriteRequest[] = [];
  readonly fileReads: FileReadRequest[] = [];
  readonly files = new Map<string, string>();

  scriptHandler: (req: ScriptRequest) => ScriptResult = () => ({ stdout: "", stderr: "", exitCode: 0 });
  httpHandler: (req: HttpRequest) => HttpResult = () => ({ status: 200, body: "" });

  runScript(req: ScriptRequest): Promise<ScriptResult> {
    this.scriptCalls.push(req);
    return Promise.resolve(this.scriptHandler(req));
  }

  runHttp(req: HttpRequest): Promise<HttpResult> {
    this.httpCalls.push(req);
    return Promise.resolve(this.httpHandler(req));
  }

  writeFile(req: FileWriteRequest): Promise<void> {
    this.fileWrites.push(req);
    this.files.set(this.key(req.cwd, req.path), req.content);
    return Promise.resolve();
  }

  readFile(req: FileReadRequest): Promise<string> {
    this.fileReads.push(req);
    const value = this.files.get(this.key(req.cwd, req.path));
    if (value === undefined) return Promise.reject(new Error(`No such file: ${req.path}`));
    return Promise.resolve(value);
  }

  private key(cwd: string, path: string): string {
    return `${cwd}::${path}`;
  }
}
