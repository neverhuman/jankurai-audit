#!/usr/bin/env bash
set -euo pipefail
node --input-type=module - <<'JS_ROTATION'
const expires = process.env.AUTOMATION_TOKEN_EXPIRES ?? '';
const parsed = Date.parse(`${expires}T00:00:00Z`);
const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || canonical !== expires) {
  console.error('::error::FAMILY_AUTOMATION_TOKEN_EXPIRES must be the token\'s real YYYY-MM-DD expiry. Refusing to assume a date.');
  process.exitCode = 1;
} else {
  const remaining = Math.ceil((parsed - Date.now()) / 86400000);
  if (!Number.isFinite(remaining) || remaining <= 14) {
    console.error(`::error::Rotate FAMILY_AUTOMATION_TOKEN before ${expires}; ${remaining} days remain.`);
    process.exitCode = 1;
  } else console.log(`FAMILY_AUTOMATION_TOKEN rotation due ${expires}; ${remaining} days remain.`);
}
JS_ROTATION
