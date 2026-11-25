---
schema: state/1
org_id: ACME
level: company
last_updated: 2026-11-07
framework_version: 0.11.0
next_action: 28
next_decision: 14
---

# State of Acme

## Products and status

- Acme app: code repo https://github.com/example-owner/acme-app (private), beta in progress

## Key numbers

- none

## Risks

- Beta feedback not yet reviewed (owner: cos)

## Open decisions

- none

## Waiting on the CEO

- ACME-A2 [low]: in https://example.com/settings upload the new `assets/logo.png` under General > Logo; there is no API for it (since 2026-11-04)
- ACME-A23 [normal]: OK for the CoS to allow automation to create pull requests on example-owner/acme-app (Settings > Actions), needed to open release PRs (since 2026-11-07)
- ACME-A24 [normal]: OK for the CoS to allow squash merge only on example-owner/acme-app, PR title as commit message (since 2026-11-07)
- ACME-A25 [normal]: OK for the CoS to add a ruleset on main of example-owner/acme-app requiring the checks "Title check" and "Build" (since 2026-11-07)
- ACME-A26 [low]: OK for the CoS to enable private vulnerability reporting on example-owner/acme-app (since 2026-11-07)
- ACME-A27 [low]: OK for the CoS to run scripts/backfill-releases.sh --apply on example-owner/acme-app: publishes 12 tags and releases (dry run first) (since 2026-11-07)
