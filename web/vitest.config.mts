import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"],
    // le test bout-en-bout démarre un vrai serveur : il a sa propre config (npm run test:e2e)
    exclude: ["tests/e2e/**", "node_modules/**"], testTimeout: 30000 },
});
