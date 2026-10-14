# omp-designer v5 architecture

## Design constraints

The runtime should improve design work without becoming the work. It therefore:

- injects one concise prompt,
- exposes five package-relative skills,
- never gates ordinary tools,
- never mutates MCP configuration,
- keeps project state per working directory,
- runs only bounded delivery checks,
- records enough trace data to diagnose duplicate registration.

## Runtime flow (OMP)

This flow is OMP-specific. Pi is described separately below.

```text
/designer
    │
    ├─ persist enabled state for cwd
    │
before_agent_start
    ├─ remove an older v5 prompt from the prompt array
    ├─ append one current v5 prompt
    └─ record session start (baseline for change detection + fallback id)
    │
resources_discover
    └─ expose five conditional skills
    │
agent work
    ├─ local inspection
    ├─ optional, task-driven MCP use
    └─ proportional artifacts and implementation
    │
session_stop  (post-execution detection, not pre-execution enforcement)
    ├─ approval plan: objective scope checks, at most one rewrite
    └─ implemented project (only if project files changed this session):
       ├─ quality validator
       ├─ layout validator
       ├─ project build
       └─ at most one repair continuation
```

The model also runs and reports delivery checks itself. The session-stop hook is
a post-execution backstop, not a state machine and not proof of browser QA. It is
gated on real file changes since the recorded session start: a pure chat or
planning turn produces no build spawn and no side effects.

For a user-requested approval turn, the injected prompt omits the delivery-review
skill path and build checks. The runtime reads the final assistant text and checks
only objective plan requirements recoverable from the user prompt. A failed plan
gets one targeted rewrite context; a second failure settles without another
continuation. An explicitly requested detailed specification bypasses the plan
length ceiling; an unrequested overlong plan gets one tightening continuation.

Session ids prefer the host `session_id`. When the host omits it, the adapter
falls back to a monotonic per-session token combined with the cwd so separate
sessions in the same directory do not collide.

## Runtime flow (Pi)

Pi shares `before_agent_start` prompt injection, `resources_discover`, plan-intent
detection, and the bounded plan-only continuation. Pi's `session_stop` runs the
plan check only. Pi has no delivery-check backstop: it never runs the quality,
layout, or build validators and writes no trace files. This is a host capability
difference, not a bug; Pi is prompt-only plus plan checks. Documentation must not
present Pi and OMP as at parity.

## Duplicate-load defense

OMP can discover the same source through a plugin and an explicit path. Separate
loader realms can isolate both `globalThis` and environment writes, so
registration uses three layers:

- a realm-local `Symbol.for` marker,
- a process-wide PID marker in the environment,
- an atomic process-scoped lock file for isolated Bun loader realms.

`/designer-doctor` separately reports an old manual-copy risk. Installation
documentation requires one install mechanism.

## State

`~/.omp/agent/designer-state.json` maps absolute working directories to booleans.
Writes use a temporary file and atomic rename. A legacy global state is read for
migration. Automation can override state with `OMP_DESIGNER_MODE`.

## Skills

| Skill | Loaded when |
| --- | --- |
| designer-master | substantive design work |
| design-md | new visual language or major redesign |
| expression | choosing the ambition dials and the page's signature moment |
| animate | meaningful motion is requested or present |
| review-skill | delivery review |
| run | the app has to be launched, driven, or captured |
| run-skill-generator | launching the app took real work and belongs in a project run skill |
| dataviz | numbers are drawn rather than listed |

No skill-read order is technically enforced. Prompt contract tests protect the
important behavior: immediate-build requests do not trigger questionnaires, small
edits remain proportional, and MCP use is optional.

Each skill's frontmatter carries a `when_to_use` trigger next to its
description; the description remains what the host surfaces in discovery, so the
trigger is documentation for readers and hosts that render it.

Skill reads are measured, never enforced. `shared/skill-usage.mjs` parses the
session transcript at `session_stop` and records, per skill, how often it was
named and whether a distinctive passage of its own body appears. A filename
mention is not a read, and a transcript that cannot be located reports a reason
rather than a clean result. The line lands in the trace (`skill_usage`) and in
`/designer-doctor`.

## Contract assembly

The contract is assembled per turn, not injected as one frozen block.
`buildContract({ planOnly, fragments, vibe })` composes the base contract with
zero or more conditional fragments and the owner-preference section; a turn that
earns none gets the default bytes exactly, which
`scripts/__tests__/fixtures/contract-v5.1-*.txt` pin.

The fragments are `motion`, `dataviz`, `forms`, and `verify`. A fragment appears when the
request words or an installed dependency put that concern in scope, and a flag of
`false` suppresses it regardless of the request. Flags resolve in this order:
`OMP_DESIGNER_FLAGS` (JSON in the environment), then `.omp/designer-flags.json`
in the working directory, then the defaults (all on). A missing file, unreadable
file, malformed JSON, unknown key, or wrong value type falls back to the default,
so a typo in a flag file cannot change behaviour silently or take the workflow
down. `/designer-doctor` prints the effective flags and their sources.

`## Delivery checks` is a named constant, so the plan-only variant removes the
block by identity instead of by a regex that quietly stops matching when the
wording changes. Each check records a status (`pass`, `fail`, `not-measured`);
the verdict stays pass/fail because every check this runtime runs marks itself
skipped only when it cannot apply. The not-measured list is recorded anyway, and
the contract instructs the model to report anything it could not run itself
rather than implying the page was verified.

## Driving the app

`run` and `run-skill-generator` port the discipline the claude-code harness gets
from its `run` skill and its drivers: running means launching the app and
interacting with it, a blank frame is a failure to launch, and work that made
launching possible is captured as a per-project run skill
(`<project>/.omp/skills/run-<unit>/SKILL.md` plus the driver it names) instead of
being rediscovered.

`scripts/designer-driver.mjs` is the driver for web and static work: it starts or
attaches to the app, captures a full page at 1440 and 375, collects console
errors, page errors and failed requests, writes `screenshots/driver-report.json`,
and exits non-zero when the app never answered or a capture is blank. Playwright
is resolved from the project (or `--playwright` / `DESIGNER_PLAYWRIGHT`) and is
deliberately not a dependency of this package; when it is absent the driver
writes a report saying so and exits 2, because a page that was never rendered is
not evidence. `shared/driver-report.mjs` holds the report contract — a report
that is missing, truncated, or malformed reads as no evidence, never as success.

`scripts/designer-canvas.mjs` (and the `/designer-canvas` command) assembles the
canvas: authored `project/*.dc.html` boards plus the driver's captures, laid out
on one deterministic grid with an index in claude-code's shape
(`canvas.json` with `boards` + `order`), written as `designer-canvas.html` in the
project. The driver rebuilds it after every run, so the sheet always matches the
freshest captures — including a failed run, where seeing the broken board is the
point. A board name is escaped in both the markup and the embedded index, because
a filename is not trusted input.

The stop-time evidence record reads that report, so the record can say
`driver: ok (2 captures, 0 console errors)` rather than only counting captures,
and `/designer-doctor` prints the project's run skill and whether the driver is
present.

## MCP boundary

The extension reads MCP configuration only for the doctor summary. Server
installation, credentials, enablement, retries, and lifecycle remain owned by the
agent host and user. A reference-server failure cannot stop local implementation.

## Validators

`fix-ai-slop.mjs` separates:

- blockers: unsupported visible claims and concrete commerce promises,
- warnings: cadence, vague language, and remote placeholder risk.

For automatic delivery checks, the extension passes the original user prompt in
memory as `DESIGNER_USER_FACTS`. This trusted input overrides model-authored
ledgers, preventing the agent from labelling its own invented claim as user-supplied.

`analyze-layout.mjs` checks a selected palette, documented source colors, contrast,
responsive signals, and reduced motion. Missing documentation and style drift are
warnings unless they produce an objective accessibility failure.

`audit-data.mjs` validates CSV structure and contrast centrally so malformed
reference rows fail package tests.

`shared/delivery-claims.mjs` compares the claims a session's final message makes
about its own verification against these recorded facts, because the delivery
checks verify the project and never the sentence shipped with it. Two rules:
`claim-contradicts-check` when the summary says something passed and the record
shows it failed, and `claim-unverified-evidence` when the summary claims a look
at rendered output the record cannot support, or a passing build for a project
where nothing of the kind was measured. Findings ride the same bounded repair
turn as the taste review, in their own block. Precision is deliberate: a negated
sentence is a disclaimer rather than a claim, and an absence with nothing to
compare against is left alone, because a check that punishes honest reporting has
already failed.

At every frontend `session_stop` the trace also records `screenshot_evidence`:
how many captures exist, how many predate the newest source edit, and a state of
`fresh`, `stale`, `missing`, or `none`. A capture that does not exist cannot be
evidence of a clean render, so the absence is recorded even when nothing is
asked of the model. The `missing-screenshot-evidence` taste rule — a visual
surface changed this session and the project holds no capture — fires only for
substantive work (the same `filesScanned >= 3` bar that asks for `DESIGN.md` and
`PRODUCT.md`), keeping the demand proportional to a real frontend delivery. The
last state also appears in `/designer-doctor`, next to the skill set's context
cost (`8 files, 56KB if all were read; largest designer-master 17KB`): the
contract is a few KB per turn, and the skills are a ceiling paid only for the ones
a turn actually opens.

## Evaluation

`real-agent-eval.mjs` launches the actual `omp` CLI with a chosen model in an
isolated child of `test-output/`. It builds and validates candidate and baseline,
counts screenshots by prefix or `screenshots/` directory, requires at least two
created after the latest source change, and reports composition risk signals.
Visual inspection remains mandatory because deterministic checks cannot measure
hierarchy, originality, or whether a screenshot proves the claimed viewport. This
harness is manual and needs model credentials; it is not part of `npm test`.

`scripts/__tests__/host-bridge.test.ts` and `scripts/e2e-smoke.mjs` provide the
automated adapter evidence. They simulate the documented OMP/Pi host event
contract against the real adapter modules — registration, one-time prompt
injection, five-skill discovery, plan-continuation exactness, delivery-check
gating, duplicate-load, and the OMP/Pi capability difference. This is simulated
evidence: it does not prove a live OMP host emits identical event shapes, and it
does not drive a real model. `e2e-smoke.mjs --real-omp` reports `SKIPPED` (never
`PASS`) when OMP or credentials are absent.

## Release boundary

`check-release.mjs` inspects `npm pack --dry-run --ignore-scripts`, verifies the
v5 runtime files (including `shared/security.mjs`), rejects legacy gate/MCP
mutation strings, and scans for secret patterns in two places: the packed
artifact and the repo working tree (dotfiles, docs, tests, examples). Placeholder
tokens are allowed; real-looking secrets fail. Tests and generated output are not
published. Secret patterns come from the single source `shared/security.mjs`,
shared with runtime trace redaction.

## Installation boundary

The package exposes a dry-run-first `omp-designer` lifecycle CLI:

- `uninstall` delegates registered-plugin removal to omp, then removes only the
  known v2 extension and 12 known managed-skill directories;
- `install-local` validates and links the current checkout;
- `install-local --clean` composes both operations for pre-publish testing.

A normal uninstall also removes state, traces, and obsolete gate/phase data.
`--keep-data` is an explicit local-reinstall exception. MCP files, credentials,
general OMP sessions, and unrelated memory are outside the package ownership
boundary. Lifecycle regression tests use a temporary HOME and fake omp binary so
they cannot mutate the developer's real installation.
