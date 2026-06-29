---
name: code-review
description: Review the current git diff for bugs, security issues, and clarity, then summarize findings by severity.
---

# Code review

Use this when the user asks to review changes, a PR, or "what did I break".

## Steps (keep it few-round-trip)

1. Get the scope in one call:
   - `git` with `["diff", "--stat"]` to see changed files, then
   - `git` with `["diff"]` (or `["diff", "--", "<path>"]` for a big change) to read the actual diff.
   - Prefer reading the diff over reading whole files; use `read_many` only for files you must see in full.
2. Review for, in this order:
   - **Correctness**: logic errors, off-by-one, null/undefined, error handling, async/await misuse.
   - **Security**: injection, secrets in code, missing authz/validation, unsafe file/command use.
   - **Clarity/maintainability**: naming, dead code, duplication, missing tests.
3. For anything you're unsure is real, say so — don't pad with nits.

## Output

Group findings by severity:

- 🔴 **Blocking** — must fix before merge (with file:line and a concrete fix).
- 🟡 **Should fix** — important but not blocking.
- 🟢 **Nit** — optional polish.

End with a one-line verdict (safe to merge / needs work) and, if asked, offer to
apply fixes via `apply_patch`.
