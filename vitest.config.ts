import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mini-claude-code/core": resolve(rootDir, "packages/core/src/index.ts"),
      "@mini-claude-code/tools": resolve(rootDir, "packages/tools/src/index.ts"),
      "@mini-claude-code/ui": resolve(rootDir, "packages/ui/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts"],
    globals: false
  }
});
