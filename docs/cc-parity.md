# cc parity: what we matched, what we did not, and why

This is the evidence-based version of the "why does the claude-code harness do well
on frontend" question. Every cc-side claim below was read out of the extracted
bundles (`G:/unbuned/output/cc-2296/claude.js`, 2.1.296, and `cc-2278/2.1.js`,
2.1.278) or their decoded assets, and names the symbol or asset it comes from. It
is a working list, not a scoreboard: several rows are deliberately **not portable**
because the difference is the host, not the idea.

## Mechanisms

| cc mechanism | evidence in the bundle | here | status |
| --- | --- | --- | --- |
| Prompt assembled per call | `getPromptForCommand(){ return await TBt() }` (73 hits) | `buildContract()`, `CONTRACT_FRAGMENTS` | **match** (shape) |
| Conditional sections spliced by flag | `<!-- dataviz-callout -->` inside `artifact-design`; the paragraph appears only when the flag is on and the dataviz skill is present | four fragments (`motion`, `dataviz`, `forms`, `verify`) keyed on request words or an installed dependency | **match** (trigger differs: cc keys on artifact type + tenant flag, we key on the request) |
| Tenant flags | ~885 `tengu_*` GrowthBook keys; `tengu_cobalt_plinth*` guards the Artifact surface | `OMP_DESIGNER_FLAGS` > `.omp/designer-flags.json` > defaults | **partial, by design** — we have no control plane, so the flag file *is* the tenant |
| Skills as the doctrine channel | 243 assets; `artifact-design` (`SKILL-10242110`, 21KB), `artifact-diagramming`, `artifact-components`, `artifact-data-table`, `artifact-explainer`, `artifact-report`, `artifact-pr-review`, `workshop`, `whiteboard`, `prototype`, `design`, `design-sync`, `dataviz` + 7 references (47KB) | 8 skills: `designer-master`, `design-md`, `expression`, `animate`, `review-skill`, `run`, `run-skill-generator`, `dataviz` | **partial** — doctrine and data display covered; the artifact-*type* family has no home without a publish surface (see below) |
| Every skill carries a trigger | `whenToUse` (98 hits); e.g. `artifact-design`'s says "Load before writing any artifact, including a skill-instructed Markdown one" | `when_to_use` on all 8, with offer discipline on the ones that self-offer | **match** |
| Skills listed in full when bundled | `skill_listing` attachment; `source === "bundled"` is exempt from the listing character budget | all 8 listed with full descriptions | **match at our scale** (no budget pressure with 8 files) |
| A live design canvas | `canvas.json` v3 keys (`boards`, `order`, `pages`, `designSystems`, `createdOnFiles`, `launch`), boards as `*.dc.html`, `AppifactRepl` (`files.list/read/readMany/publish`), `board.mjs` renderer (87KB); published changes reach open viewers automatically | `canvas.json` (`boards`, `order`, `cell`) + `designer-canvas.html`; `designer-canvas.mjs --serve` runs a local server that watches the project, rebuilds on any change and pushes a reload over SSE, so a capture the driver writes appears on its own | **match in behaviour** — the surface is a browser page instead of an in-app canvas, and publishing is a file write instead of an `AppifactRepl` call |
| Publish protocol with surgical retry | "If a call reports an error, fix the line it names and send THAT call again, not the others"; a refused publish re-runs from line one, once | driver exits non-zero with a report; repair turns are bounded (2 validation, 3 taste) | **partial** — our retry granularity is the turn, not the call |
| A tool the model calls for a check | `ArtifactCheck` (`verify`/`preview` map to it); its result carries captures, overflow, theme-ignoring colors, blocked loads, console errors — mid-turn, while the work is open | `designer_check`, registered through the host's `registerTool` (read out of omp v18.10.4's `ExtensionsApi`): runs the driver and returns the same field list in its tool result — verdict, captures with widths and blank flags, console/page/request failures, overflow with the offending elements, contrast below 3:1 | **match** — the earlier gap was attachment, and tools are the host's own mechanism for it |
| Verification attached to the tool | `ArtifactCheck` (`Artifact`/`ArtifactComments`/`ArtifactData`/`ArtifactCheck`; `verify` and `preview` map to it) renders desktop **and phone** in **light and dark** and lists overflow, colors that ignore the theme, blocked loads, console errors including a script that fails to parse | `designer-driver.mjs` at 1440 + 375: console/page/request errors, blank rule calibrated on measured pages, **horizontal overflow past the viewport**, and **rendered text contrast below 3:1** measured on the live DOM per width; `screenshot_evidence` + `claimFindings` at `session_stop` | **partial** — coverage matches on widths, console, overflow and contrast; the remaining differences are dark-mode-specific reporting and the fact that our diagnostics arrive at stop time rather than inside the tool result |
| "Write, check once, publish" | one preview, one pass of edits, no second look; optional except for charts of real numbers | delivery checks + taste review + one bounded repair | **match** (spirit) |
| Design plan as a token block in the file | `:root` with 4-6 named colors, 2+ type roles, a layout comment; derive everything from it, don't narrate hexes | added to `designer-master` §5 "Tokens, themes, and neutrals" | **match** (doctrine) |
| Three theme states | bare `:root` = light; `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` redefines tokens; `:root[data-theme="dark"]` for an explicit choice | same pattern, ported | **match** |
| Deliberate neutrals | "a grey with a slight hue bias toward the page's accent" | ported | **match** |
| Named AI-design banlist | warm cream `#F4F1EA` + serif + terracotta; near-black with an acid-green or vermilion pop; purple-to-blue gradient hero; Inter or Space Grotesk as the "safe" face; emoji section markers; everything centered; `rounded-lg` everywhere; accent rail on rounded cards | `docs/ai-slop.md` taxonomy (7 classes) + the `fix-ai-slop` validator (`ai-default-palette`, `gradient-heavy`, `reveal-hidden-content`, …) | **match, plus enforcement** — cc states the banlist; we state it *and* fail a check on it |
| Copy discipline | "name things by what people recognize"; ban mannered devices (em-dash asides, "not X, but Y", colon-then-reveal, scare quotes, "worth noting") | §6 Copy: promotional adjectives, specific headlines, em-dash-is-not-a-defect (cadence is) | **match** |
| Title as a product name | "a short noun phrase, typically two to four words… stop at the name; a title that adds its own explanation after a dash reads as generated filler" | ported into §6 | **match** |
| Copy never claims unverified facts | artifact `EVIDENCE.md` discipline in cc's own docs | `EVIDENCE.md` in `designer-master` §2 + the delivery-claim check | **match** |
| Output-sandbox constraints | Google Fonts is the only permitted font host (else `@font-face` data URI); libraries only as pinned UMD from cdnjs, ≥2 weeks old, stylesheet inlined; page assets ship with the page | nothing equivalent | **not portable** — a CSP of cc's hosted artifact runtime; the local-project analogue is the project's own asset policy (pin versions, don't inline a library's source, don't hotlink unlicensed media) |
| Drivers per project type | `run` skill: CLI, server, TUI (tmux), Electron `_electron` REPL, browser `chromium-cli`, library smoke; `run-skill-generator` commits the driver as the deliverable | `run`, `run-skill-generator`, `designer-driver.mjs` for web/static; the other types are documented patterns | **partial** — web is a real driver; Electron/TUI/server are instructions, not shipped code |
| Usage + cost reporting | `/skill-doctor` (usage and context cost) | `shared/skill-usage.mjs` (named vs body-read) + the `Skill context:` doctor line | **match** |
| Model-graded eval | `claude plugin eval` / `plugin eval init` with graders, `plugin-eval.md` (79.9KB) | `real-agent-eval.mjs` (manual, model-backed, not in `npm test`) | **gap — this is Phase 4** |
| Artifact comments / data store | `ArtifactComments`, `ArtifactData` (`read_db`, `write_db`) | none (traces only) | **not portable** — there is no hosted artifact store in a local project |

## What the diff actually says

Three differences explain most of the quality gap, and only one of them is a
feature:

1. **A surface in the loop.** cc renders every board the moment it lands, and
   `ArtifactCheck` can tell the model about overflow and theme mistakes while the
   work is still open. Our nearest equivalents are the driver and the canvas, one
   gesture behind, and our diagnostics arrive at `session_stop`.
2. **Doctrine that is always present.** cc ships its page contract inside a tool
   description (~20KB) and inside skills that are listed in full. We now ship a
   comparable per-turn contract plus 8 skills, and the total is 56KB *if every
   skill were read* — a ceiling, not a per-turn cost.
3. **A grader.** cc can measure whether a session drove the app, captured it, and
   told the truth. We have the checks but not the instrument that grades a model's
   behaviour against them. That is the honest remaining gap, and Phase 4.

## Concrete next steps, in order

1. **Phase 4 — grade it.** Extend `real-agent-eval.mjs` with graders matching cc's
   `plugin eval`: did the session run the driver, produce captures after the last
   source edit, and avoid a claim its record contradicts. (`designer_check` now
   gives a grader an unambiguous signal to look for: a `designer_check` trace event.)
2. ~~Close the diagnostic gap that needs no host~~ — **done**: the driver now
   measures horizontal overflow past the viewport and rendered text contrast on the
   live DOM at each width, prints them, and the summary carries them
   (`ok (2 captures, 0 console errors, 3 layout warnings)`). Still missing from
   `ArtifactCheck`'s list: a dark-mode pass and blocked-load attribution beyond
   request failures.
3. **Artifact-type analogues, deliberately scoped.** `artifact-explainer`,
   `artifact-report`, `artifact-data-table`, `artifact-diagramming` are *publishable
   artifact types* in cc. Locally the deliverable is a real page or route, so if we
   port them, they should be templates for project pages — not a fake publish
   surface.
