import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAG_ENV, resolveFlags, describeFlags, FLAG_DEFAULTS } from "../../shared/designer-flags.mjs";

process.env.OMP_DESIGNER_MODE = "1";

// Dynamic, not static: the module reads OMP_DESIGNER_MODE and its instance guard
// at load time, so it must be imported after the environment above is set. This
// is the module-loading boundary the suite exercises.
const module = await import("../../extension/index.ts");
const { buildContract, CONTRACT_FRAGMENTS, fragmentNamesFor, checkStatus, PACKAGE_ROOT } = module;

const handlers = new Map<string, Array<(event?: unknown, ctx?: { cwd?: string }) => unknown>>();
const api = {
  registerCommand() {},
  on(event: string, handler: (event?: unknown, ctx?: { cwd?: string }) => unknown) {
    const entries = handlers.get(event) ?? [];
    entries.push(handler);
    handlers.set(event, entries);
  },
};
module.default(api);

afterAll(() => {
  delete process.env.OMP_DESIGNER_MODE;
  delete process.env.OMP_DESIGNER_V5_REGISTERED_PID;
  delete process.env[FLAG_ENV];
});

// Two normalizations, both required for a comparison that survives a
// re-checkout: absolute roots differ per machine, and git may hand the fixture
// back with CRLF while the contract literal is built with LF. Folding only one
// of them makes the golden pass here and fail in a fresh clone.
const normalize = (text: string): string =>
  text.replace(/\r\n/g, "\n").split(PACKAGE_ROOT).join("{{ROOT}}");
const fixture = (name: string): string =>
  normalize(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "contract-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("contract assembly", () => {
  test("the default contract is byte-identical to the frozen v5.1 contract", () => {
    expect(normalize(buildContract())).toBe(fixture("contract-v5.1-build.txt"));
  });

  test("the plan-only contract is byte-identical to the frozen v5.1 plan contract", () => {
    expect(normalize(buildContract({ planOnly: true }))).toBe(fixture("contract-v5.1-plan.txt"));
  });

  test("a fragment is additive and keeps the marker block intact", () => {
    const base = buildContract();
    const withMotion = buildContract({ fragments: ["motion"] });
    expect(withMotion).not.toBe(base);
    expect(withMotion.startsWith(base.slice(0, base.indexOf("\n[/DESIGNER MODE]")))).toBe(true);
    expect(withMotion).toContain(CONTRACT_FRAGMENTS.motion.trim());
    expect(withMotion.endsWith("[/DESIGNER MODE]")).toBe(true);
    expect(withMotion.match(/\[DESIGNER MODE: ACTIVE v5\]/g)).toHaveLength(1);
  });

  test("fragment order is the declared order regardless of request order", () => {
    const assembled = buildContract({ fragments: ["forms", "motion"] });
    expect(assembled.indexOf(CONTRACT_FRAGMENTS.motion.trim()))
      .toBeLessThan(assembled.indexOf(CONTRACT_FRAGMENTS.forms.trim()));
  });

  test("an unknown fragment name is ignored instead of injected as text", () => {
    expect(buildContract({ fragments: ["nonsense"] })).toBe(buildContract());
  });

  test("a vibe section still lands exactly where the old marker replace put it", () => {
    const vibe = "\n\n## Owner preferences (persistent, set with /designer-vibe)\nflat, no gradients";
    const legacy = buildContract().replace(/\n\[\/DESIGNER MODE\]$/, `${vibe}\n\n[/DESIGNER MODE]`);
    expect(buildContract({ vibe })).toBe(legacy);
  });

  test("vibe and fragments compose in one pass", () => {
    const assembled = buildContract({ fragments: ["dataviz"], vibe: "\n\n## Owner preferences\nx" });
    expect(assembled.indexOf(CONTRACT_FRAGMENTS.dataviz.trim()))
      .toBeLessThan(assembled.indexOf("## Owner preferences"));
  });
});

describe("fragment inference", () => {
  const allOn = { motion: true, dataviz: true, forms: true };
  const empty = makeProject({ "package.json": JSON.stringify({ name: "app", dependencies: {} }) });

  test("request words put a concern in scope", () => {
    expect(fragmentNamesFor("add a scroll-reveal hero", empty, allOn)).toEqual(["motion"]);
    expect(fragmentNamesFor("build a metrics dashboard", empty, allOn)).toEqual(["dataviz"]);
    expect(fragmentNamesFor("build a signup form", empty, allOn)).toEqual(["forms"]);
  });

  test("an unrelated request gets no fragments", () => {
    expect(fragmentNamesFor("fix a typo in the readme", empty, allOn)).toEqual([]);
  });

  test("an installed dependency is a signal on its own", () => {
    const project = makeProject({
      "package.json": JSON.stringify({ name: "app", dependencies: { "framer-motion": "^11", recharts: "^2" } }),
    });
    expect(fragmentNamesFor("polish the landing page", project, allOn)).toEqual(["motion", "dataviz"]);
    rmSync(project, { recursive: true, force: true });
  });

  test("a disabled flag suppresses its fragment regardless of the request", () => {
    const flags = { motion: false, dataviz: true, forms: true };
    expect(fragmentNamesFor("add a scroll-reveal animation", empty, flags)).toEqual([]);
    expect(fragmentNamesFor("add a scroll-reveal animation", empty, { ...flags, motion: true })).toEqual(["motion"]);
  });

  test("a project without a manifest still reads the request words", () => {
    const bare = mkdtempSync(join(tmpdir(), "contract-bare-"));
    expect(fragmentNamesFor("add a chart", bare, allOn)).toEqual(["dataviz"]);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("flag resolution", () => {
  test("defaults are on, so an unconfigured project behaves as before", () => {
    const { flags, sources, ignored } = resolveFlags({ cwd: tmpdir(), env: {} });
    expect(flags).toEqual({ ...FLAG_DEFAULTS });
    expect(sources).toEqual([]);
    expect(ignored).toEqual([]);
    expect(describeFlags({ flags, sources, ignored })).toContain("(defaults)");
  });

  test("a project file overrides the default and the env overrides the file", () => {
    const cwd = makeProject({ ".omp/designer-flags.json": JSON.stringify({ motion: false }) });
    expect(resolveFlags({ cwd, env: {} }).flags.motion).toBe(false);
    const env = { [FLAG_ENV]: JSON.stringify({ motion: true, dataviz: false }) };
    const merged = resolveFlags({ cwd, env });
    expect(merged.flags.motion).toBe(true);
    expect(merged.flags.dataviz).toBe(false);
    expect(merged.sources).toHaveLength(2);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("malformed JSON, wrong types, and unknown keys cannot change behaviour", () => {
    const broken = makeProject({ ".omp/designer-flags.json": "{ motion: " });
    expect(resolveFlags({ cwd: broken, env: {} }).flags).toEqual({ ...FLAG_DEFAULTS });
    rmSync(broken, { recursive: true, force: true });

    const cwd = makeProject({
      ".omp/designer-flags.json": JSON.stringify({ motion: "yes", unrelated: true, dataviz: false }),
    });
    const { flags, ignored } = resolveFlags({ cwd, env: {} });
    expect(flags.motion).toBe(true);
    expect(flags.dataviz).toBe(false);
    expect(ignored).toEqual(["motion (not a boolean)", "unrelated"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("an unreadable env value falls back to defaults and is reported as a source", () => {
    const { flags, sources } = resolveFlags({ cwd: tmpdir(), env: { [FLAG_ENV]: "not json" } });
    expect(flags).toEqual({ ...FLAG_DEFAULTS });
    expect(sources[0]).toContain("unreadable");
  });
});

describe("injection through the real handler", () => {
  test("the injected prompt carries the fragment the request earns", () => {
    const handler = handlers.get("before_agent_start")?.[1] ?? handlers.get("before_agent_start")?.[0];
    expect(handler).toBeDefined();
    const cwd = makeProject({ "index.html": "<h1>x</h1>" });
    const result = handler?.({ prompt: "build a page with a scroll-reveal hero", systemPrompt: [] }, { cwd }) as
      | { systemPrompt?: string[] }
      | undefined;
    const injected = result?.systemPrompt?.join("\n") ?? "";
    expect(injected).toContain(CONTRACT_FRAGMENTS.motion.trim());
    expect(injected).not.toContain(CONTRACT_FRAGMENTS.forms.trim());
    rmSync(cwd, { recursive: true, force: true });
  });

  test("with the flag off the same request injects the plain contract", () => {
    const handler = handlers.get("before_agent_start")?.[1] ?? handlers.get("before_agent_start")?.[0];
    const cwd = makeProject({ "index.html": "<h1>x</h1>", ".omp/designer-flags.json": JSON.stringify({ motion: false }) });
    const result = handler?.({ prompt: "build a page with a scroll-reveal hero", systemPrompt: [] }, { cwd }) as
      | { systemPrompt?: string[] }
      | undefined;
    const injected = result?.systemPrompt?.join("\n") ?? "";
    expect(injected).not.toContain(CONTRACT_FRAGMENTS.motion.trim());
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("delivery check status", () => {
  test("a check that could not run is not a pass", () => {
    // ok is true on a skipped check for backwards compatibility, so the status
    // is what decides. Reporting it as a pass is the false green this pins.
    expect(checkStatus({ name: "build", ok: true, skipped: "no build script", output: "" })).toBe("not-measured");
    expect(checkStatus({ name: "quality", ok: true, output: "" })).toBe("pass");
    expect(checkStatus({ name: "layout", ok: false, output: "3 violations" })).toBe("fail");
  });
});
