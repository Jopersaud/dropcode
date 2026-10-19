import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "web/test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
