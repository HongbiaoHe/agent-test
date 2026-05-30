# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed.

## 0. Rules

- **No auto-commit**: Never run `git commit`, `git push`, or any git write operation on your own. All code changes must be reviewed by the user, and only committed when the user explicitly asks.

- **No "done" without a Verification section** — applies to ALL workflows. Skills, plans, sub-agents, `/apply`, `/quick`, custom commands do NOT exempt this rule.

  Any message that claims completion (English: "done / fixed / verified / works / ready". 中文："完成 / 改好了 / 验证通过 / 没问题 / 可以了") MUST end with a `## Verification` section in this exact shape:

  ```
  ## Verification
  - [command or check] → [actual output / result, or `not run` + reason]
  - [factual claim made above] → [file:line] (or `unverified` + reason)
  ```

  Rules:
  - **No section = not done.** If you can't fill it in, you haven't finished — keep working or ask the user.
  - Every factual claim in the message (about code behavior, cron periods, constants, data flow, etc.) must appear in the section with a `file:line` citation, OR be explicitly marked `unverified`. Words like "应该 / 通常 / 印象中 / 按惯例 / 大概 / should / probably" must be replaced with verified facts or removed.
  - For code changes: must include type check command + test command + (for UI / endpoint / SSR) an actual exercise of the feature. `tsc` clean alone is NOT enough.
  - For docs (design / spec / plan / audit / review / analysis): every load-bearing claim needs `file:line`.
  - Sub-agent / skill output is NOT verification — re-verify the load-bearing claims yourself.
  - When unclear: stop and ask the user. Do not guess.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

