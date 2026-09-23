import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env.CURSOR_ACP_E2E ? [] : ["test/e2e/**"],
    testTimeout: 60_000,
  },
});
