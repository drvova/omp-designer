---
name: run
description: "Launch and drive this project's app to see a change working. Use when asked to run, start, preview, or screenshot the app, or to confirm a change works in the real app rather than only in tests."
when_to_use: Load when the request mentions running, starting, previewing, screenshotting, or verifying the app; before reporting that anything works in the browser or in the app.
---

**Running means launching the actual app and interacting with it** — not the test
suite, not an import of an internal function plus a `console.log`. The app as a
user meets it: the CLI at its command, the server at its socket, the GUI at its
window.

## First: does a project run skill already cover this?

A project run skill is this repository's verified path — whoever wrote it already
cold-started the app on this machine and committed what actually worked.

Look in `<project>/.omp/skills/run-*/SKILL.md` (and `.claude/skills/run-*/` for
repos that carry both), and read its `description:` lines before its body.

- **One describes launching or driving this app** → follow it verbatim. Do not
  paraphrase it, and do not skip the steps it flags as required.
- **Stale** — it fails on mechanics unrelated to your task → say so, and offer to
  refresh it with the run-skill-generator skill.
- **Nothing about running** → use the pattern below.

## Otherwise: match the shape, use the pattern

| Project type | Handle | First move |
| --- | --- | --- |
| CLI tool | direct invocation, exit code, stdin/stdout | run it with a representative argument |
| Web server / API | background launch, then HTTP | start it, `curl` the route the change touches |
| TUI / interactive terminal | tmux `send-keys` / `capture-pane` | navigate, capture the pane |
| Desktop / Electron | Playwright `_electron` REPL | launch, click, screenshot (no `xvfb` on Windows — run it headless or offscreen) |
| Browser app | dev server + the shipped driver | `node <package>/scripts/designer-driver.mjs --start "<dev cmd>" --url <url>` |
| Static page | open the file | `node <package>/scripts/designer-driver.mjs --url file:///<path>` |

The driver captures a full page at 1440 and 375, collects console errors,
page errors and failed requests, writes `screenshots/driver-report.json`, and
exits non-zero when the app never answered or a capture is blank. Reach for it
before writing ad-hoc screenshot code.

## Drive it, don't just launch it

Launching with no interaction proves the entrypoint resolves. That is
typechecking with extra steps. Drive it to a point where a user would see
something:

- **CLI** → type a representative command, read the exit code and the output.
- **Server** → hit the route the change touches, read the body, not just the status.
- **TUI** → send a navigation key, capture the pane, read the pane.
- **GUI or page** → click the thing, screenshot the window or page, and **look at
  the screenshot**. A blank frame is a failure to launch, not a styling problem.

Then say what you saw, in the terms the capture shows: which sections rendered,
what the console said, what broke at the narrow width. "It builds" is not a
report about the app.

## Reporting honestly

- Name the exact command, the URL, and the widths you captured.
- If something failed, say which step and paste the error — a partial run that
  reports itself as partial is worth more than a clean claim.
- If you could not run the app at all, say that plainly and say why. A check you
  could not run is not a pass.

## If the pattern cost you real work

If launching took installed packages, environment variables, patched config, or
a driver you had to write — that work is the content of a project run skill.
Recommend generating one (run-skill-generator) so the next session starts from
your findings instead of rediscovering them. If it just worked, do not.
