# Installing omp-designer

There are two lineages of this package and they are not interchangeable:

- **the published package** — `omp install npm:omp-designer`, the released line;
- **this fork** — the checkout at `G:\omp-designer`, which carries work the release
  does not, and is the copy every session on this machine is meant to run.

Installing the published package does not error. It **replaces the fork silently**
for every session that follows, so the behaviour you get no longer matches the
source sitting next to you. That is the mistake this document exists to prevent.

## The rule

```
DO      node scripts/install-local.mjs            # dry run: prints the plan, changes nothing
DO      node scripts/install-local.mjs --apply --clean   # apply: uninstall + link + gate
NEVER   omp install npm:omp-designer@latest
NEVER   omp plugin install omp-designer
NEVER   npm i -g omp-designer
```

`install:local:clean` uninstalls whatever plugin is currently registered, keeps
state (`designer-state.json`) and traces, runs the gate and
`node scripts/check-release.mjs`, links this checkout with `omp plugin link <root> --force
--scope user`, and then asserts that the plugin's real path **is** this package
root and that the versions match. It refuses to finish otherwise.

**Restart omp afterwards.** A running process keeps the extension modules it
loaded at startup: the link is correct on disk while the session in front of you
is still executing the old code. This is also why a pre-link session can still be
enforcing a gate that this checkout does not contain.

## Verify it (four proofs, each one catches a different mistake)

```bash
omp plugin list --json     # want: version 5.1.x, path ...\.omp\plugins\node_modules\omp-designer
omp plugin doctor          # its omp-designer line must describe THIS fork
node scripts/check-plugin-link.mjs   # identity check, exits non-zero on another copy
```

```python
import os, hashlib, json
plug, mine = r"C:\Users\bigmo\.omp\plugins\node_modules\omp-designer", r"G:\omp-designer"
print("resolves to mine:", os.path.realpath(plug).lower() == os.path.realpath(mine).lower())
print("version:", json.load(open(os.path.join(plug, "package.json"), encoding="utf-8"))["version"])
for rel in ("shared/delivery-claims.mjs", "shared/driver-report.mjs", "skills/run.md"):
    a = hashlib.sha256(open(os.path.join(plug, *rel.split("/")), "rb").read()).hexdigest()[:12]
    b = hashlib.sha256(open(os.path.join(mine, *rel.split("/")), "rb").read()).hexdigest()[:12]
    print(rel, "MATCH" if a == b else "DIFFERS")
```

- `os.path.realpath()` is the check that means something: the plugin path is a
  **junction**, and `os.path.islink()` returns `False` for one.
- Hashing files that exist **only in the fork** (`shared/driver-report.mjs`,
  `skills/run.md`) distinguishes a junction from a stale copy, which a version
  string alone cannot.
- `~/.omp/plugins/package.json` must not list `omp-designer` as a dependency, and
  `~/.omp/plugins/cache/plugins` must be empty — a dependency entry there means an
  npm resolution can come back and overwrite the link.

## Symptoms of the published copy being live

Any one of these is enough:

- `/designer-reset` is offered — this fork registers only `designer`,
  `designer-vibe`, and `designer-doctor`;
- a skill gate demands skills that are not in `skills/` (this fork ships seven:
  `animate`, `design-md`, `designer-master`, `expression`, `review-skill`, `run`,
  `run-skill-generator`), and reading the missing ones is impossible because they
  were deleted;
- `omp plugin list` shows a 4.x version;
- `/designer-doctor` prints a `Loaded module:` path outside this checkout (it also
  appends `<- NOT this checkout (npm copy detected)` when it notices).

## Recovery

```bash
node scripts/install-local.mjs --apply --clean   # re-links and re-runs the gate
```

then restart omp. Nothing else is needed: no cache clearing, no reinstall. If a
session is still blocked by the old gate, that session's process is the problem,
not the disk — restart it rather than trying to satisfy the gate.
