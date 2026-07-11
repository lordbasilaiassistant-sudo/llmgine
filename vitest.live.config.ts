import { defineConfig } from "vitest/config";

/**
 * Live suite — real GLM API calls. Requires ZAI_API_KEY (or LLM_API_KEY +
 * LLM_BASE_URL for another provider). Run locally before releases:
 *   npm run test:live
 * Never runs in CI.
 */
export default defineConfig({
  test: {
    include: ["src/**/live.test.ts"],
    testTimeout: 90_000,
  },
});
