# CLAUDE.md

## Agent skills

### Issue tracker

Issues live as GitHub issues in `babear/Dida`; every skill uses the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-named labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md` for how to read and use them. Before writing to either, read its rules: `~/.claude/skills/domain-modeling/GLOSSARY-FORMAT.md` and `ADR-FORMAT.md`.

**Writing to `GLOSSARY.md` or anything under `docs/adr/` goes through `/domain-modeling`.** The glossary and ADRs are the project's agreed vocabulary and decisions, not a scratch pad for whatever the current change implies — a wording edit there redefines terms other docs and code rely on.

Escalate to `/grill-with-docs` when the change involves a trade-off, records a new decision, or reshapes the model (splitting a term, renaming a concept, adding or revising an ADR). A stale definition or a typo does not need the interview.

## Workflow

Write PR bodies with `/pr` — "push and open a PR", "open a PR", "write the PR description" all trigger it.
