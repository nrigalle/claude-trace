import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

delete process.env["ELECTRON_RUN_AS_NODE"];

try {
  await runTests({
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: path.join(repoRoot, "test", "smoke", "suite.cjs"),
  });
  console.log("SMOKE OK");
} catch (err) {
  console.error("SMOKE FAILED", err);
  process.exitCode = 1;
}
