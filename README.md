# omp-designer v5

Focused UI/UX workflow for [Pi](https://pi.dev) and
[oh-my-pi](https://github.com/can1357/oh-my-pi).

Version 5 removes the mandatory 12-skill gate and MCP state mutation. It provides
nine skills (core workflow, visual system, expression toolkit, motion, delivery
review, running the app, and authoring a project run skill), a concise system
prompt assembled per turn with four conditional fragments, an anti-slop and
art-direction core, evidence-aware validators, a shipped browser driver,
screenshot content analysis, a bounded taste-repair loop, an optional
model-backed visual reviewer, and a reproducible real-agent comparison harness.

## Install

This checkout is the install. Point the host at it directly and prove the host
really loaded it:

```bash
node scripts/install-local.mjs            # dry run: prints the plan, changes nothing
node scripts/install-local.mjs --apply --clean
node scripts/check-plugin-link.mjs        # prove the registered plugin is this directory
```

`--apply --clean` clears the current registration and the known v2 manual copies,
runs the [gate](#validation), then links this directory with `omp plugin link`.
Restart the host afterwards and run `/designer-doctor`.

Install with **exactly one mechanism**. A second copy — a copied extension in an
agent extension directory, or a registry install sitting beside the link — can
register the hooks twice, and it replaces the link silently for later sessions.
`check-plugin-link.mjs` exists to catch exactly that; it exits non-zero when the
host is running something other than this directory.

Dry-run and explicit variants, all from this directory:

```bash
node scripts/install-local.mjs              # preview only
node scripts/install-local.mjs --apply      # link only; refuses a legacy mix
node scripts/uninstall-system.mjs           # preview only
node scripts/uninstall-system.mjs --apply   # remove all package-owned host data
```

From any directory, address the installed copy directly:

```bash
# Preview
node "$HOME/.omp/plugins/node_modules/omp-designer/scripts/lifecycle-cli.mjs" uninstall

# Apply full uninstall
node "$HOME/.omp/plugins/node_modules/omp-designer/scripts/lifecycle-cli.mjs" uninstall --apply
```

[docs/installation.md](docs/installation.md) has the full detail, the four
verification proofs, and the symptoms of the wrong copy being live.

Measuring the harness itself (did the session render the page, capture it after its
last edit, and tell the truth about it): [docs/eval.md](docs/eval.md).

Working a design *with* someone — one open decision per turn, the choice made by
clicking the canvas, the next turn told what was chosen:
[docs/workshop.md](docs/workshop.md).

The contract fragments are also real flags: `--designer-motion`,
`--designer-dataviz`, `--designer-forms`, `--designer-verify`,
`--designer-workshop` (each takes `=false` to suppress it for a session).

### Parity with the claude-code harness

`docs/cc-parity.md` is the evidence-based comparison: which mechanisms this
extension matches, which are partial, and which are deliberately not portable
(a hosted artifact sandbox, a tenant flag service, an artifact data store). Every
cc-side claim there cites the symbol or asset it was read from.

### Local checkout

Use a plugin link when testing this checkout:

```bash
node scripts/install-local.mjs --apply --clean
node scripts/uninstall-system.mjs            # inspect what cleanup would remove
```

`install-local.mjs --apply --clean` removes the current `omp-designer`
registration and the known v2 manual extension/managed-skill copies, runs the
gate and the release check, then links this checkout with `omp plugin link`. It
uses the explicit `--keep-data` path so comparison traces survive. Restart the
host and run `/designer-doctor` before a real-agent comparison. See
[docs/install-lifecycle.md](docs/install-lifecycle.md) for the full transition
matrix and retained-data policy.

Toggle the workflow:

```text
/designer
```

The mode is stored per project. `OMP_DESIGNER_MODE=1` and
`OMP_DESIGNER_MODE=0` provide explicit overrides for automation.

## What v5 loads

- `designer-master`: proportional product-design workflow, art direction,
  human-taste marks, named-reference protocol
- `design-md`: visual-system contract for new pages and redesigns
- `expression`: ambition dials, signature-moment menu, and working recipes
  (scroll scenes, rails, kinetic type, texture, load choreography)
- `animate`: optional motion guidance
- `review-skill`: delivery and browser review, substitutability test

Supporting assets: `data/gallery/` (three complete reference pages that meet
the system's bar), `data/qa/overlap-check.js` (browser snippet reporting
overlapping or clipped text), and `docs/ai-slop.md` (the canonical slop
definition and taxonomy).

Skills remain package-relative. There is no managed-skill copy and no requirement
to read every skill before using tools. Skill reads are not technically enforced;
v5 relies on the focused prompt, plan checks, delivery checks, and evals rather
than a skill-read gate. Where the host does not emit read events, skill
consumption is not directly observable.

## Hosts: OMP and Pi

The two adapters share prompt injection, nine-skill discovery, plan-intent
detection, and one bounded plan-only continuation. They are not at parity:

| Capability | OMP (`extension/index.ts`) | Pi (`extensions/designer.ts`) |
| --- | --- | --- |
| Focused prompt injection | yes | yes |
| Nine-skill `resources_discover` | yes | yes |
| Plan-intent detection + bounded plan-only continuation | yes | yes |
| Post-execution delivery checks (quality/layout/build on `session_stop`) | yes | no |
| Bounded taste review (slop rules, blank screenshot bands, screenshot-evidence record, optional visual reviewer) | yes | no |
| Contract assembled per turn (four flag-gated fragments: motion, dataviz, forms, verify) | yes | no |
| Browser driver (`designer-driver.mjs`: 1440 + 375 captures, console errors, driver report) | yes | no |
| Design canvas (`designer-canvas.html`: boards + captures on one page, cc-shaped `canvas.json`; `--serve` rebuilds and reloads open viewers over SSE) | yes | no |
| `designer_check` tool (driver diagnostics returned in the tool result, mid-turn) | yes | no |
| Trace events under `~/.omp/agent/designer-traces` | yes | no |
| Tool interception / skill-read hard gate | none | none |
| MCP mutation | none | none |

Pi is prompt-only plus plan checks. It has no delivery-check backstop; the OMP
`session_stop` delivery path is host-specific and is not mirrored on Pi.

## Security and key hygiene

- No API key belongs in this repository. `.env` is gitignored; keep real
  credentials outside the repo (for example under `~/.config/…` sourced by your
  shell) and copy `.env.example` when you need a local `.env`.
- If a live key was ever committed or left in the working tree, rotate it.
- `node scripts/check-release.mjs` scans both the packed tarball and the repo working tree
  (including dotfiles) for secret patterns. Placeholders such as
  `<YOUR_OPENAI_API_KEY>` are allowed; real-looking secrets fail the check.
- Runtime trace redaction and the release scanner share one pattern source,
  `shared/security.mjs`.

## MCP policy

MCP servers are optional references, not workflow gates. The extension observes
their configuration in `/designer-doctor` but never edits `mcp.json` and never
enables or disables a server.

Useful optional servers:

- `chrome-devtools`: browser inspection when the built-in browser is insufficient
- `ui-layouts`: relevant layout/component references
- `21st-dev-magic`: component or SVG search; API key required
- `designmd`: external design-system references; API key required

Configure only the servers a team actually uses. Pin versions in shared or
production configuration.

## Validation

```bash
node scripts/gate.mjs              # every suite in the package.json chain, in order
node scripts/gate.mjs --only eval  # one family of suites while iterating
node scripts/gate.mjs --list       # what the chain contains, without running it
node scripts/check-release.mjs     # packed-file and secret checks before a release
```

The quality validator blocks unsupported visible claims and commerce promises.
Stylistic signals such as a single em dash are warnings. The layout validator
checks documented colors and objective contrast failures without requiring a
full design document for a small edit.

During omp delivery checks, claim support comes from the original user prompt
held in extension memory. Agent-generated PRODUCT.md or EVIDENCE.md cannot
self-authorize a fact. Standalone CLI use falls back to those ledgers unless
`DESIGNER_USER_FACTS` is supplied.

Approval-plan turns use a separate read-only prompt without delivery-review
instructions. A bounded plan check catches objective scope failures such as
collapsing requested pages into one page, missing concrete routes, unsolicited
forms or metrics, dead links, and scroll-jacking. It may request one rewrite and
never forms an autonomous loop. An explicitly requested detailed specification is
allowed to exceed the length ceiling; an unrequested overlong plan gets one
tightening continuation, not a hard rejection.

On OMP, `session_stop` delivery checks are a post-execution backstop, not
pre-execution enforcement. They run only after real project files change during a
session; a pure chat or planning turn spawns no build. A failed check yields one
bounded repair continuation. Pi does not run this backstop.

### Simulated host-bridge and optional real smoke

```bash
node scripts/gate.mjs --only host-bridge   # simulated OMP/Pi host contract, real adapters
node scripts/e2e-smoke.mjs                 # same, as a reportable smoke run (--real-omp to attempt)
```

The host-bridge suite drives the real adapter hooks through a simulated host (no model, no
live OMP process): registration, one-time prompt injection, skill discovery,
plan continuation exactness, delivery-check gating, duplicate-load, and the
OMP/Pi capability difference. It is simulated evidence, not proof that a live
OMP host emits identical event shapes. `e2e:smoke --real-omp` is optional and
reports `SKIPPED` (never `PASS`) when OMP or model credentials are unavailable.

Run validators against another project:

```bash
node scripts/fix-ai-slop.mjs --check /path/to/project
node scripts/analyze-layout.mjs /path/to/project
```

## Real-agent comparison

Generated projects and reports are kept under `test-output/` (gitignored, never
packed). This directory can grow to gigabytes; reclaim space with a dry-run-first
cleanup that retains the JSON reports and e2e-canary as release evidence:

```bash
node scripts/cleanup-artifacts.mjs             # dry run: lists what it would remove
node scripts/cleanup-artifacts.mjs --apply     # delete generated runs, keep evidence
```

Real-agent runs themselves:

```bash
node scripts/real-agent-eval.mjs \
  --run fieldnote-r1 \
  --case saas \
  --baseline test-output/previous-run \
  --model opencode-go/deepseek-v4-flash:xhigh
```

The harness runs the real `omp` agent, builds the result, runs both validators,
counts named screenshots, records composition warning signals, and emits a JSON
comparison in `test-output/reports/`. A run is invalid unless its isolated trace
proves prompt injection, a delivery outcome, and no adjacent duplicate hook event.
Generation refuses to start unless OMP reports this checkout as the sole clean
v5 plugin source. The harness does not add a second explicit extension path.

This harness is a manual tool: it needs a local `omp`, a model provider, and
credentials, and its artifacts live in untracked `test-output/`. It is not part
of the gate and is not automated clean-install E2E evidence. The simulated
host-bridge suite is the automated adapter evidence; a real-model run here is
complementary manual verification.

Its numeric score measures delivery evidence, not visual taste. Screenshots must
still be reviewed. A valid iteration is:

1. establish one clean install source and restart omp,
2. run the same case against a baseline,
3. inspect desktop and mobile screenshots,
4. record concrete failures,
5. change the smallest responsible prompt, skill, validator, or runtime behavior,
6. rerun the same case and compare.

Earlier v5 agent runs were useful runtime and validator comparisons, but the host
still contained a disabled v2 extension and 12 legacy managed-skill directories.
They were therefore not clean-install E2E evidence. Lifecycle behavior is now
covered in an isolated temporary HOME, and the R8 DeepSeek comparison was run
after a clean link with one v5 plugin source and no explicit extension
double-load.

## Commands

- `/designer`: toggle for the current working directory
- `/designer-vibe <text>`: persistent per-project design preferences, injected
  as standing user decisions (`/designer-vibe clear` resets; no text shows the
  current value)
- `/designer-doctor`: inspect source path, duplicate-install risk, runtime assets,
  and MCP configuration

## Model-backed visual review

`node scripts/design-review-cli.mjs --target <project>` has a vision-capable model look
at the project's screenshots and fill a structured design rubric (verdict,
the one memorable thing, top fixes), saved as `design-review.json`.

- Default reviewer: `opencode-go/minimax-m3:high`. If you do not have access
  to it, set any vision-capable model with `--model` or
  `DESIGNER_REVIEW_MODEL` (see the images column in `omp models`), or use
  `--via api` with `DESIGNER_REVIEW_BASE_URL` for any OpenAI-compatible local
  endpoint such as LM Studio.
- A vision-blind model is rejected honestly (`cannot view the images`), never
  trusted with a rubric it did not see.
- The eval harness runs this reviewer by default (`--no-review` skips,
  `--review-model` overrides) and attaches the judgment to its reports.
- At runtime, setting `DESIGNER_REVIEW_MODEL` makes the `session_stop` taste
  review feed the reviewer's zero-scored categories and top fixes into the
  bounded repair loop.

`node scripts/build-gallery.mjs` builds `test-output/gallery.html`: every run's screenshots,
scores, slop-rule hits, and reviewer verdicts side by side.

## Runtime structure

```text
extension/index.ts               omp extension (prompt, plan checks, delivery backstop)
extensions/designer.ts           Pi extension (prompt + plan checks, no backstop)
shared/security.mjs              shared secret patterns for redaction and release scan
shared/workshop.mjs              the workshop decision loop: question block, log, panel
skills/                          nine skills (incl. run, run-skill-generator, dataviz, workshop)
scripts/designer-driver.mjs      browser driver: captures, console errors, driver-report.json
scripts/designer-canvas.mjs      canvas: every board and capture on one page (+ canvas.json)
scripts/designer-eval.mjs        eval suite: cases + graders, with/without arms (docs/eval.md)
scripts/gate.mjs                 the whole test chain, in order, with no package manager
evals/                           the shipped cases (prompt.md + graders/*.md)
scripts/check-plugin-link.mjs    proves the installed plugin is this checkout, not another copy
data/ui-ux-pro-max/              palette and typography search data
scripts/fix-ai-slop.mjs          evidence-aware copy validator
scripts/analyze-layout.mjs       proportional layout/contrast validator
scripts/audit-data.mjs           CSV integrity and contrast audit
scripts/audit-trace.mjs          duplicate-load and delivery trace audit
scripts/real-agent-eval.mjs      manual real-model comparison harness (--suite for the normal-prompt corpus)
scripts/design-review-cli.mjs    model-backed visual review (rubric from screenshots)
scripts/build-gallery.mjs        local gallery of all runs (test-output/gallery.html)
shared/screenshot-analysis.mjs   PNG decoder + blank-band metrics
data/gallery/                    three golden reference pages
data/qa/overlap-check.js         browser overlap/clipping QA snippet
scripts/e2e-smoke.mjs            simulated host-bridge smoke runner (optional --real-omp)
scripts/gate.mjs                 runs every suite in the package.json chain, no package manager
scripts/check-release.mjs        packed-artifact and repo-wide secret release gate
scripts/cleanup-artifacts.mjs    dry-run-first cleanup for generated test-output
scripts/install-local.mjs        safe local-link installer
scripts/uninstall-system.mjs     dry-run-first omp cleanup
scripts/__tests__/host-bridge.test.ts  simulated OMP/Pi host-contract tests
```

## Requirements

- Node.js 20.19 or newer
- Pi or omp
- a configured model provider for real-agent evaluations

No API key belongs in this repository, chat transcript, command argument, or
generated report.
