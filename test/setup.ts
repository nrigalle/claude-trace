import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = path.join(os.tmpdir(), `claude-trace-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env["CLAUDE_TRACE_PROJECTS_DIR"] = TMP;

process.on("exit", () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
});
