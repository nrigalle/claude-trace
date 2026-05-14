import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/stress/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30_000,
    pool: "threads",
    reporters: ["default"],
    environmentMatchGlobs: [["test/unit/dom/**", "happy-dom"]],
  },
});
