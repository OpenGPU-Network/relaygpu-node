// The SDK under e2e test: src/ by default; the packed tarball installed in examples/ when
// RELAY_E2E_TARBALL=1 (A1: `npm pack` → `cd examples && npm install`). Types come from src/.
import type * as Src from "../../src/index.js";

const sdk: typeof Src = process.env.RELAY_E2E_TARBALL
  ? await import(new URL("../../examples/node_modules/@relaygpu/client/dist/index.js", import.meta.url).href)
  : await import("../../src/index.js");

export const { Relay, IdempotencyKeyReusedError, KeyBudgetExhaustedError, PermissionDeniedError, ScopeDeniedError, ModelNotFoundError, ModelRetiredError, RelayAPIError, NotFoundError, TaskFailedError } = sdk;
export const from = process.env.RELAY_E2E_TARBALL ? "tarball" : "src";

/** Staging only: skips without a key/base URL, refuses production hosts. */
export const env = {
  apiKey: process.env.RELAY_API_KEY,
  baseUrl: process.env.RELAY_BASE_URL,
  get ready() {
    return Boolean(this.apiKey && this.baseUrl && !/relaygpu\.com|relay\.opengpu\.network|:1301\b/.test(this.baseUrl));
  },
};
