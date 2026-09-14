import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
