---
name: run-skill-generator
description: "Author or refresh the project's run skill — the per-project skill that records how to build, launch, and drive this app on this machine. Use after you worked out how to run the app, or when asked to set the project up, write run instructions, or make the app reliably launchable."
when_to_use: Load right after you spent real effort making the app run (installs, env vars, config patches, a driver), or when the user asks for setup instructions, a run skill, or a reliable way to screenshot the app.
---

Produce a skill at `<project>/.omp/skills/run-<unit>/` that lets a later session
build, launch, and **drive** this app without rediscovering anything.

The skill has two parts that live together:

```
<project>/.omp/skills/run-<unit>/
  SKILL.md      what it is, how it is driven, what bites you
  driver.mjs    the code that does it (or an inline command when one script is enough)
```

That almost always means **writing the driver**, not only prose. A markdown file
cannot click a button. Sometimes the driver already exists: for a web app it is
`scripts/designer-driver.mjs` in this package; for a server it is `curl`; for a
TUI it is tmux. Then the skill is the script that runs it.

## Definition of done

You are finished when all of these are true:

1. **You launched the app on this machine and interacted with it** — in this
   session, not in principle and not from reading the README.
2. You captured what a user would see: a screenshot for a GUI or page (the
   driver's 1440 and 375 pair), a response body for a server, an exit code and
   output for a CLI, a pane for a TUI.
3. `SKILL.md` states one path, not a menu of options, and every claim in it is
   something you ran.
4. A reader who follows it cold, without deviating, gets the same result.

If you are about to write the skill and you do not have (1), **stop**. You are
about to paraphrase the README, and the README is exactly what was not enough.

## Where the skill goes

- One deployable thing per skill: `<project>/.omp/skills/run-<unit>/`, where
  `<unit>` is the app, service, or package directory's basename.
- Slugify: lowercase, dashes for spaces, no slashes (`run-billing-api`).
  The directory name and the frontmatter `name:` should match.
- Monorepo with several runnable pieces and no obvious one → ask which unit.

## Process

### 0. Look for an existing one

List the project's skills with their `description:` lines. If one already covers
launching this app — whatever it is named — **refine, don't rewrite**: verify its
claims, fix what is wrong, add what is missing, keep the name, and re-run its
driver.

### 1. Discover, and treat every existing claim as disprovable

Read the manifest (`package.json`, `pyproject.toml`, `Cargo.toml`), the scripts,
the Dockerfile, the CI config, and the README. **CI configs are usually more
accurate than the README.** Negative claims are the ones to distrust most: "does
not work on Windows" in a README written on macOS means "nobody tried on
Windows". You are about to try.

### 2. Execute, and build the harness you need

Keep a running note as you go: every error, every fix, every command that finally
worked. That note becomes the Gotchas section, and it is the part a later session
cannot reconstruct.

Obstacles are content. A coordinate system that does not line up, an API that
returns empty on this version, a flag that hides the thing you need to test —
each one earns a bullet and often a helper in the driver.

### 3. Write SKILL.md

Short. Point at the driver.

- Frontmatter `description:` carries the **verbs an agent would actually type**:
  run, start, build, test, screenshot, verify. A generic description will not
  match a request.
- Frontmatter `when_to_use:` says when to load it, including the moment it is
  worth offering unprompted — at most once per session, one short line, then
  stop and wait.
- Then: one paragraph on what the app is and how it is driven; prerequisites that
  actually had to exist; the exact commands; the URLs and ports; the file the
  driver writes; a Gotchas section; and what "working" looks like on screen.
- Paths in `SKILL.md` are relative to `<project>/`, not to the skill directory.
  Say so if there is any ambiguity.
- Mark flaky or slow steps as flaky or slow. Honesty about a 40-second startup
  saves a later session from concluding the app is broken.

### 4. Verify from a fresh shell

`cd` into the unit, follow `SKILL.md` line by line without improvising. Any
improvisation you needed is a gap in the skill — fix the skill, not your memory.

## On Windows, specifically

- `npx playwright` / `playwright-core` come from the project's `node_modules`;
  resolve them from there rather than assuming a global install.
- No `xvfb`. Headless is the default; when a page needs a visible window, launch
  a real channel (`msedge`, `chrome`) instead of reaching for a virtual display.
- Kill a backgrounded server by process tree: `taskkill /PID <pid> /T /F`.
- Prefer `cmd /c` or a written `.bat` over long shell pipelines; MSYS mangles
  POSIX-looking paths and `&` chains.

## Red flags — you are about to ship the wrong thing

- You never took a screenshot of a GUI or page. You did not run it.
- The skill lists options ("you can use npm or bun or pnpm") instead of the one
  path that worked.
- It documents a command you never executed.
- It documents the app, not how to *drive* it — there is nothing a later session
  can click, call, or capture.
