---
name: model-fusion
description: Gather independent, identically framed opinions from Codex, Google Antigravity CLI (agy), and Cursor Agent, then let Codex make and execute the final evidence-based decision. Use for debugging, implementation planning, code or design review, architecture decisions, security analysis, risk assessment, and other high-impact engineering work where the user asks for multiple model opinions, model fusion, a council, cross-checking, or consensus.
---

# Model Fusion

Use Codex as the coordinator, final adjudicator, and only implementation agent. Use AGY and Cursor Agent as read-only reviewers.

## Core invariants

- Give Codex, AGY, and Cursor the exact same decision brief and response contract.
- Record Codex's independent baseline before viewing external responses.
- Run AGY and Cursor concurrently after the baseline is fixed.
- Do not decide by majority vote or average self-reported confidence.
- Prefer reproducible evidence over agreement.
- Let only Codex modify files, run consequential commands, and present the final decision.
- Never install, update, log in to, or reconfigure either external CLI unless the user explicitly requests it.
- Preserve partial results when one reviewer fails or times out.

## Workflow

### 1. Select the mode

Choose one primary mode:

- `debug`: identify root causes, competing hypotheses, minimal fixes, and reproduction checks.
- `plan`: compare implementation approaches, sequencing, dependencies, migration risks, and tests.
- `review`: find correctness, security, performance, maintainability, and test-coverage problems.
- `decision`: compare alternatives and recommend one under explicit constraints.

### 2. Build one neutral decision brief

Create a single prompt containing:

1. Mode and exact question.
2. Goal and acceptance criteria.
3. Relevant repository context, files, diff, logs, or test failures.
4. Constraints and explicitly excluded work.
5. Known facts separated from assumptions.
6. The response contract from [references/response-and-synthesis.md](references/response-and-synthesis.md).

Do not reveal the user's preferred answer or ask reviewers to validate Codex's opinion. Ask for conclusions and concise evidence, not hidden chain-of-thought. Store the final prompt as UTF-8 text so the same bytes can be reused.

### 3. Produce and freeze the Codex baseline

Before invoking external reviewers, answer the common prompt independently using the response contract. Treat this as the `codex` response and do not revise it until all external responses are available.

### 4. Run external reviewers

Confirm `agy` and `cursor-agent` are present with read-only checks. If available, run:

```bash
python3 <skill-dir>/scripts/run_external_reviewers.py \
  --prompt-file <run-dir>/prompt.md \
  --workspace <workspace> \
  --output <run-dir>/external-responses.json
```

The runner uses:

- `agy --print --mode=plan --sandbox`
- `cursor-agent -p --mode=plan --sandbox enabled --output-format text`

Do not replace plan mode with an editing mode. If the runner reports workspace changes, stop synthesis long enough to inspect and disclose them; do not automatically discard user files.

### 5. Normalize and verify

Read [references/response-and-synthesis.md](references/response-and-synthesis.md) before adjudication.

- Label every claim as observed, inferred, or unsupported.
- Deduplicate findings that describe the same underlying issue.
- Verify high-impact claims using repository inspection, tests, static analysis, or authoritative documentation.
- If reviewers disagree on a consequential point, run a targeted check first. If it remains unresolved, send a second-round prompt containing the competing claims anonymously and ask what evidence would falsify each one.
- Do not assume the three participants use independent underlying models; report them as three reviewer surfaces.

### 6. Decide and act

Produce the final synthesis using the required Markdown format in the reference. State one final decision unless evidence genuinely cannot resolve the choice. Then, if the user's request includes implementation, Codex alone makes the changes and verifies them.

## Failure handling

- Missing CLI: continue with available reviewers and reduce the stated confidence.
- Authentication or quota failure: report it as unavailable; never request or expose credentials in the shared prompt.
- Invalid JSON response: use the preserved raw response and normalize it manually.
- Timeout: retain completed responses and note the missing reviewer.
- Sensitive repository: omit secrets, credentials, personal data, and unrelated proprietary content from the prompt. External reviewers send context to their configured providers.

## Related skills

- [Grok Advisor](grok-advisor/SKILL.md): Get a read-only second opinion from Grok or explicitly delegate an authorized implementation task.
- [Delegate](delegate/SKILL.md): Select relevant repository skills and delegate explicitly authorized implementation work to Cursor Agent.
