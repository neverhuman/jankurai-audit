# Family contracts

Owns the portable family manifest, lock and gate contracts documented here.
`gate-contract.md` is the lane surface every member's `scripts/ci-local.sh` and
`ops/ci/required.sh` must hold; `scripts/gate-contract.mjs` checks it.
Keep revision pins in `family.lock`, preserve immutable GitHub identities, and
validate changes with `bash scripts/validate-family.sh` and `npm test`.
Generated fusion outputs remain read-only; update their generating code.
