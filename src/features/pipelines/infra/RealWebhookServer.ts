import * as http from "http";
import * as vscode from "vscode";

import { webhookPipelineForToken } from "../app/TriggerScheduler";
import type { Pipeline, PipelineId } from "../domain/types";

export class RealWebhookServer {
  private server: http.Server | null = null;

  constructor(
    private readonly listPipelines: () => readonly Pipeline[],
    private readonly runPipeline: (id: PipelineId) => void,
  ) {}

  start(): void {
    const port = vscode.workspace.getConfiguration("claudeTrace").get<number>("webhookPort", 0);
    if (!port || port <= 0) return;
    const server = http.createServer((req, res) => {
      const token = this.tokenFrom(req);
      const pipelineId = token === null ? null : webhookPipelineForToken(this.listPipelines(), token);
      if (pipelineId === null) {
        res.writeHead(404);
        res.end("no matching webhook trigger");
        return;
      }
      this.runPipeline(pipelineId);
      res.writeHead(202);
      res.end("run started");
    });
    server.on("error", (err) => {
      void vscode.window.showWarningMessage(`Claude Trace webhook server failed: ${err.message}`);
    });
    server.listen(port, "127.0.0.1");
    this.server = server;
  }

  private tokenFrom(req: http.IncomingMessage): string | null {
    const url = new URL(req.url ?? "/", "http://localhost");
    const fromQuery = url.searchParams.get("token");
    if (fromQuery !== null) return fromQuery;
    const header = req.headers["x-webhook-token"];
    return typeof header === "string" ? header : null;
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
  }
}
