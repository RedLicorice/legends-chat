import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    // Default to node for DB-backed route tests; opt .tsx component tests into jsdom.
    environment: "node",
    environmentMatchGlobs: [["__tests__/**/*.test.tsx", "jsdom"]],
    setupFiles: ["./__tests__/setup.ts"],
    testTimeout: 30_000,
  },
});
