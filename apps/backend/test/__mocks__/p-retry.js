// CJS stub for p-retry (ESM-only package) — used in Jest test environment only.
// The real p-retry is ESM and cannot be required() by Jest's CommonJS runner.
// This stub provides a minimal pRetry(fn) that just calls fn() once (no retries).
'use strict';
function pRetry(fn) {
  return fn(0);
}
pRetry.AbortError = class AbortError extends Error {};
module.exports = pRetry;
module.exports.default = pRetry;
module.exports.AbortError = pRetry.AbortError;
