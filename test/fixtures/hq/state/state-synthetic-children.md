---
schema: state/1
org_id: ACME
level: company
last_updated: 2026-01-16
framework_version: 0.21.0
next_action: 12
next_decision: 6
---

# State of the company

## Open decisions
- ACME-D5: decide the beta price (since 2026-01-13; proposed by cos)

## Waiting on the CEO
- ACME-A7 [high] {ok}: launch the beta once the items below are done (since 2026-01-12)
  - ACME-A8 [normal] {ok}: approve the store copy in docs/beta-copy.md (since 2026-01-12)
  - ACME-D5 [normal] {decide}: decide the beta price, see decision queue (since 2026-01-13)
- ACME-D3 [normal] {wait}: pricing model decided (decision 0012); follow-ups below (since 2026-01-10)
  - ACME-A9 [low] {do}: update the price in the store console, Pricing > Edit
    then check the preview (since 2026-01-15)
- ACME-A10 [low] {do}: plain item with no children (since 2026-01-14)
   - ACME-A11 [low] {do}: indented by three spaces, so top-level (since 2026-01-14)
    - ACME-A12 [low] {do}: indented by four spaces, so top-level (since 2026-01-14)
- ACME-D4 [normal] {wait}: a group heading with no child (since 2026-01-09)
- this line has no code at all
  - ACME-A13 [normal] {do}: child of an unparsed line, so top-level (since 2026-01-15)

## Risks
- none
