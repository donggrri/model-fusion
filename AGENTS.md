# Multi-agent repository rules

- The main Codex agent owns the user requirements, task scope, final decision, integration, and verification.
- Resolve external agent availability from [agents/availability.yaml](agents/availability.yaml). Never invoke an agent that is disabled, missing, unauthenticated, or not configured for the requested capability.
- Parallelize independent read-only exploration, testing, and review when they do not mutate shared state.
- Never let multiple agents modify the same checkout at the same time. Use one writer for a workspace; use separate Git worktrees and branches for competing implementations.
- Do not merge, discard, reset, commit, push, deploy, or send external messages unless the user explicitly authorizes that action.
- Every agent handoff must report findings, changed files, tests or checks run, failures, blockers, and remaining risks.
- Inspect the working tree and diff after every delegated implementation. Preserve existing user changes and partial results from failed or timed-out agents.
- Hermes is optional infrastructure, not an implicit dependency. Do not invoke or assume a Hermes runtime unless the active environment configuration explicitly provides one.
