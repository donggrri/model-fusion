# Response and synthesis contract

## Contents

1. Common reviewer response
2. Mode-specific emphasis
3. Evidence hierarchy
4. Adjudication rules
5. Final synthesis format
6. Confidence calibration

## 1. Common reviewer response

Append this contract unchanged to the common prompt. Require one JSON object and no Markdown fences.

```json
{
  "mode": "debug | plan | review | decision",
  "verdict": {
    "summary": "One-sentence conclusion",
    "recommended_action": "The single best next action",
    "confidence": 0
  },
  "findings": [
    {
      "id": "F1",
      "claim": "Concise, falsifiable claim",
      "basis": "observed | inferred | unsupported",
      "severity": "critical | high | medium | low | info",
      "evidence": [
        {
          "path": "repository-relative path or null",
          "line": "line number/range or null",
          "detail": "What directly supports the claim"
        }
      ],
      "impact": "Why this matters",
      "recommendation": "Specific response to this finding"
    }
  ],
  "alternatives": [
    {
      "option": "Alternative approach",
      "benefits": ["Benefit"],
      "costs": ["Cost or trade-off"],
      "choose_when": "Condition that makes this preferable"
    }
  ],
  "risks": [
    {
      "risk": "Failure mode",
      "likelihood": "high | medium | low",
      "impact": "high | medium | low",
      "mitigation": "Concrete mitigation"
    }
  ],
  "verification": [
    {
      "step": "Command, inspection, or experiment",
      "expected": "Result that supports the recommendation",
      "falsifies": "Result that would reject it"
    }
  ],
  "assumptions": ["Assumption"],
  "unknowns": ["Information still needed"]
}
```

Rules:

- Keep `confidence` between 0 and 100.
- Use repository-relative paths. Do not invent line numbers.
- Use `observed` only for directly inspected code, logs, tests, or supplied facts.
- Use `inferred` when connecting observations to a conclusion.
- Use `unsupported` when evidence is unavailable; keep such claims out of the final decision unless verified later.
- Return conclusions and evidence summaries, not private chain-of-thought.
- Do not edit files or execute consequential actions.

## 2. Mode-specific emphasis

### Debug

- Include at least one competing root-cause hypothesis when plausible.
- Make every root-cause claim falsifiable.
- Prefer the smallest safe fix and name regression tests.

### Plan

- Identify dependencies, ordering constraints, rollout or migration steps, rollback, and acceptance tests.
- Compare at least two approaches when the choice is architectural.

### Review

- Focus on actionable findings rather than summaries.
- Attach an exact location to every code-specific finding.
- Do not report style preferences as defects unless a project rule supports them.

### Decision

- State the decision criteria and which option wins each criterion.
- Include a reversal condition: what new fact would change the recommendation.

## 3. Evidence hierarchy

Rank support in this order:

1. Reproduced runtime behavior or passing/failing tests.
2. Exact code, configuration, or diff reference.
3. Repository documentation and declared constraints.
4. Authoritative external documentation.
5. General engineering practice.
6. Reviewer assertion without supporting evidence.

Agreement increases confidence only when the reviewers reached the claim independently and the claim has evidence. Three unsupported assertions do not outweigh one reproduced result.

## 4. Adjudication rules

For each material claim:

1. Match equivalent findings across reviewers.
2. Record support, contradiction, and missing coverage.
3. Assign the strongest evidence tier available.
4. Verify critical/high findings and any disagreement that changes the decision.
5. Resolve conflicts by evidence; if evidence is tied, prefer the reversible option with the smaller failure radius.
6. Preserve credible minority findings instead of hiding them behind consensus.

Use a second round only for consequential unresolved disagreements. Present the competing claims anonymously as `Proposal A`, `Proposal B`, and so on. Ask reviewers for falsification tests, not preference votes.

## 5. Final synthesis format

Use this Markdown structure:

```markdown
## 최종 결정

[One direct decision and why it wins.]

- 신뢰도: 높음 | 중간 | 낮음
- 참여: Codex / availability config에 따라 실제 완료된 reviewer 목록
- 다음 행동: [One concrete first action]

## 합의와 차이

| 쟁점 | Codex baseline | Completed reviewer evidence (one column per completed reviewer) | Codex 판정 |
|---|---|---|---|
| ... | ... | ... | ... |

Reviewer 열은 active environment에서 `available: true`이고 실제 완료된 agent에 맞춰 동적으로 추가한다. 비활성·미설치·인증 실패 reviewer를 열로 만들거나 완료된 것처럼 표시하지 않는다.

## 확인된 근거

- [Verified fact, source/location, and how it affects the decision.]

## 주요 불일치와 해결

- [Competing claims, verification performed, and ruling.]

## 채택안

1. [Ordered implementation or response steps.]

## 제외한 대안

- [Alternative]: [specific reason rejected and when to reconsider it.]

## 검증 계획

- [Check]: [expected result and failure signal.]

## 남은 위험과 불확실성

- [Residual risk, mitigation, owner/trigger where applicable.]
```

Omit an empty section, but never omit `최종 결정`, `합의와 차이`, `확인된 근거`, or `남은 위험과 불확실성`.

## 6. Confidence calibration

- **높음**: the decisive claims are reproduced or directly verified, at least two completed participants independently converge when the active environment provides them, and no unresolved high-impact contradiction remains.
- **중간**: evidence supports the choice but some assumptions, incomplete coverage, or non-decisive disagreement remains.
- **낮음**: a reviewer is unavailable, decisive claims are mostly inferred, or a high-impact disagreement cannot be verified.

Do not calculate final confidence by averaging reviewer numbers. Explain any confidence downgrade.
