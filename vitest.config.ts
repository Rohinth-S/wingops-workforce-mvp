import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The local SQLite adapter is intentionally shared across test files.
    fileParallelism: false,
  },
});
