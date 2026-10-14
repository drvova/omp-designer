# Measuring the harness: `designer-eval`

Every other check in this package verifies the *project* or the *record*. This one
verifies the thing the package exists to change: what a session actually does when
the extension is loaded. It is the local counterpart of `claude plugin eval`,
including its case format, and it exists because "the prompt says to look at the
page" is a claim, not evidence.

```
node scripts/designer-eval.mjs --dry-run                    # every case and grader, no model call
node scripts/designer-eval.mjs                              # run the suite (spends model calls)
node scripts/designer-eval.mjs --case render-before-claim --runs 2
node scripts/designer-eval.mjs --ablation with-without      # also run with no plugin loaded
node scripts/designer-eval.mjs -- --session G:/site --transcript <session.jsonl>   # grade what exists
```

## A case is a prompt and some graders

```
evals/<case>/prompt.md          frontmatter: name, tags, runs, timeout_seconds,
                                model, allowed_tools; body is the prompt
evals/<case>/graders/<name>.md  frontmatter: type: …; body is the rubric
```

The runner scaffolds a throwaway project (or `--scaffold <dir>`), starts a real
`omp -p` session with only this extension loaded, and collects what happened:
tool calls and the final message from the host transcript, the extension's own
trace for that project, the captures on disk with their timestamps.

**What a print-mode run cannot show.** `omp -p` does not emit `session_stop`, so the
stop-time delivery path (`delivery_checks_passed`, the taste review, the claim
check) never runs in an eval arm — three live runs produced `prompt_injected` and
`designer_check` traces and not one `delivery_checks_*`. Grade what a print run can
prove: the prompt injection and the tool calls (the extension acted), the captures
and their timestamps on disk, the final message, and the traces a mid-turn tool
writes. Stop-path grading needs an interactive session; until there is a rig for
that, `designer_check` is the honesty signal the eval actually measures.

**The with-arm turns designer mode on.** The extension only acts for a project
where it is enabled, so the runner sets `OMP_DESIGNER_MODE=1` for the arm that
includes it (and `0` for the without-arm). Without that the suite grades an inert
extension and every honesty grader passes trivially — which is exactly what the
first real run of this suite did, and why the `stop_path_ran` grader exists.

## Graders

| type | reads | passes when |
| --- | --- | --- |
| `regex` | `target`: `last_message` (default), `trace`, `tool_calls`, `any` | `pattern` matches; `match: not_contains`, or `match: count:N` |
| `tool_used` | tool calls | `tool` ran between `min` (default 1) and `max` times, optionally `input_match` |
| `tool_order` | tool calls | `before` appears before `after` |
| `file_exists` | files the session **created** | a path matches the glob, at least `min` times |
| `trace_event` | the extension's trace | `event` appears between `min` and `max` times |
| `driver_ran` | tool calls, trace, driver report | the page was actually rendered — a `designer_check` call, a `designer_check` trace, or a driver report on disk |
| `captures_fresh` | capture + source mtimes | at least `count` captures exist **and** the newest is not older than the last source edit |
| `claims_consistent` | trace, last message | no `claim_mismatch`, and no `phrases` in the summary |
| `llm` | last message | a judge passes it (needs `DESIGNER_EVAL_JUDGE_CMD`; otherwise it **skips**) |

**A grader that cannot run reports `skipped` and does not pass.** That is the same
rule the extension holds the model to; the harness is not exempt from it. A case
passes only when every grader passes.

## What ships

| case | what it is for |
| --- | --- |
| `render-before-claim` | the session must render the page and capture it after its last edit before saying how it looks |
| `claim-matches-record` | the summary must not contradict the record, and the stop path must have run |
| `workshop-one-decision` | one open question per turn, and the reply must not narrate the machinery |

## Results

`<case-dir>/results/<timestamp>/results.json` (`--output-dir` to move it):

```json
{ "schemaVersion": "1",
  "suite": { "dir": "…/evals", "threshold": 1, "runs": 1, "model": "default" },
  "cases": [{ "name": "…", "tags": [], "arms": { "with": [ { "graders": [ { "name", "type", "passed", "score", "detail" } ] } ] }, "passed": true, "score": 1 }],
  "aggregates": { "cases": 3, "passed": 3, "meanScore": 1 } }
```

Exit codes: **0** every case passed at or above `--threshold`, **1** nothing passed
(or nothing could be graded), **2** partial — some passed, some did not.

## The manual half, and the honest limits

- The arms that spend model calls are **not** part of the gate: they need
  credentials and they are stochastic. What *is* in the suite is the grading path —
  `test:eval-graders` grades the graders in both directions, and
  `test:eval-runner` grades recorded sessions end to end (`--session` +
  `--transcript`) with no model involved.
- `--ablation with-without` reports the arm with no plugin loaded so a pass can be
  compared against what the model does anyway. Without it, a suite of green cases
  says only that the tasks were easy.
- The transcript parser is deliberately forgiving: an entry it cannot read is
  skipped rather than failing the run, and a missing transcript is recorded in the
  result notes instead of silently producing empty graders.
