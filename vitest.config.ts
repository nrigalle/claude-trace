import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/stubs/vscode.ts"),
    },
  },
  test: {
    include: ["test/unit/**/*.test.ts", "test/stress/**/*.test.ts", "test/integration/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30_000,
    pool: "threads",
    reporters: ["default"],
    environmentMatchGlobs: [["test/unit/dom/**", "happy-dom"]],
  },
});
