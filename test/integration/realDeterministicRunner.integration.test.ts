import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealDeterministicRunner } from "../../src/features/pipelines/infra/RealDeterministicRunner";

const runner = new RealDeterministicRunner();
const noSignal = new AbortController().signal;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-real-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("RealDeterministicRunner — scripts", () => {
  it("runs a bash script and captures stdout + exit code 0", async () => {
    const res = await runner.runScript({
      interpreter: "bash",
      code: "echo hello-from-bash",
      cwd: tmp,
      env: {},
      signal: noSignal,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello-from-bash");
  });

  it("exposes injected env vars to the script", async () => {
    const res = await runner.runScript({
      interpreter: "bash",
      code: "echo $TICKET",
      cwd: tmp,
      env: { TICKET: "API-77" },
      signal: noSignal,
    });
    expect(res.stdout.trim()).toBe("API-77");
  });

  it("runs in the provided workspace cwd", async () => {
    const res = await runner.runScript({
      interpreter: "node",
      code: "console.log(process.cwd())",
      cwd: tmp,
      env: {},
      signal: noSignal,
    });
    expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(tmp));
  });

  it("reports a non-zero exit code and stderr", async () => {
    const res = await runner.runScript({
      interpreter: "bash",
      code: "echo oops >&2; exit 3",
      cwd: tmp,
      env: {},
      signal: noSignal,
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr.trim()).toBe("oops");
  });

  it("runs a node script", async () => {
    const res = await runner.runScript({
      interpreter: "node",
      code: "console.log(2 + 3)",
      cwd: tmp,
      env: {},
      signal: noSignal,
    });
    expect(res.stdout.trim()).toBe("5");
  });
});

describe("RealDeterministicRunner — files", () => {
  it("writes then reads a file in the workspace", async () => {
    await runner.writeFile({ cwd: tmp, path: "sub/dir/out.txt", content: "payload-123" });
    expect(fs.readFileSync(path.join(tmp, "sub/dir/out.txt"), "utf8")).toBe("payload-123");
    expect(await runner.readFile({ cwd: tmp, path: "sub/dir/out.txt" })).toBe("payload-123");
  });

  it("rejects a path that escapes the workspace (traversal guard)", async () => {
    await expect(runner.writeFile({ cwd: tmp, path: "../escape.txt", content: "x" })).rejects.toThrow(
      /escapes the run workspace/,
    );
    await expect(runner.readFile({ cwd: tmp, path: "../../etc/passwd" })).rejects.toThrow(
      /escapes the run workspace/,
    );
  });
});

describe("RealDeterministicRunner — http", () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/echo") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`${req.method}:${req.headers["x-token"] ?? ""}:${body}`);
        } else if (req.url === "/down") {
          res.writeHead(503);
          res.end("unavailable");
        } else {
          res.writeHead(404);
          res.end("nope");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends method, headers, and body, and returns the response text", async () => {
    const res = await runner.runHttp({
      method: "POST",
      url: `${base}/echo`,
      headers: [{ name: "X-Token", value: "secret" }],
      body: "the-body",
      signal: noSignal,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("POST:secret:the-body");
  });

  it("returns the status for a server error without throwing", async () => {
    const res = await runner.runHttp({
      method: "GET",
      url: `${base}/down`,
      headers: [],
      body: null,
      signal: noSignal,
    });
    expect(res.status).toBe(503);
  });
});
