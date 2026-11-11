# CLAUDE.md

## Agent skills

### Issue tracker

Issues live as GitHub issues in `babear/Dida`; every skill uses the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-named labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md` for how to read and use them. Before writing to either, read its rules: `~/.claude/skills/domain-modeling/GLOSSARY-FORMAT.md` and `ADR-FORMAT.md`.

## Workflow

When fixing review comments: fix every comment first, then invoke the `code-review` skill over that change (pass the commit the change started from as the fixed point).

Write PR bodies with `/pr` — "push and open a PR", "open a PR", "write the PR description" all trigger it.
