// CJS stub for is-network-error (ESM-only package) — used in Jest test environment only.
'use strict';
function isNetworkError(error) {
  return error && error.message ? /network/i.test(error.message) : false;
}
module.exports = isNetworkError;
module.exports.default = isNetworkError;
