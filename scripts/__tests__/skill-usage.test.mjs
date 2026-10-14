#!/usr/bin/env node
/**
 * Skill-usage evidence: signature extraction, transcript unwrapping, and the
 * mention-vs-read distinction that the whole module exists to measure.
 *
 * The two failure modes this pins are the ones that make such a measurement
 * lie: counting a prompt instruction as a read, and missing a real read because
 * the transcript stores it with escaped newlines.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeUsage,
  collectSkillUsage,
  countOccurrences,
  formatUsageLine,
  loadSignatures,
  locateTranscript,
  mentionCount,
  sessionDirName,
  skillSignature,
  transcriptText,
} from "../../shared/skill-usage.mjs";

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const BODY_LINE = "Capability claims are a closed set taken from the user's own product description.";
const SKILL_FILE = `---
name: designer-master
description: "Core product-design workflow. Read for substantial UI work."
---

# Designer Master

${BODY_LINE}

## Sections

- something short
`;

test("skillSignature skips frontmatter and headings and returns a body passage", () => {
  assert.equal(skillSignature(SKILL_FILE), BODY_LINE);
});

test("skillSignature is deterministic and returns null when no passage qualifies", () => {
  assert.equal(skillSignature(SKILL_FILE), skillSignature(SKILL_FILE));
  assert.equal(skillSignature("---\nname: tiny\n---\n\n# H\n\nshort\n"), null);
  assert.equal(skillSignature(""), null);
});

test("transcriptText unwraps JSONL escaping instead of matching raw bytes", () => {
  const record = JSON.stringify({
    type: "tool_result",
    content: [{ type: "text", text: `${BODY_LINE}\nsecond line` }],
  });
  const raw = `${record}\n`;
  assert.ok(raw.includes("\\n"), "fixture must carry an escaped newline to be meaningful");
  const text = transcriptText(raw);
  // A passage that spans the line break is what a byte search cannot see: the
  // recorded form stores the break as the two characters \ and n.
  const spanning = `${BODY_LINE}\nsecond line`;
  assert.equal(countOccurrences(text, spanning), 1);
  assert.equal(countOccurrences(raw, spanning), 0, "byte search must be the failing case");
  assert.equal(countOccurrences(text, BODY_LINE), 1);
});

test("naming a skill file is not a read", () => {
  const raw = JSON.stringify({
    content: [{
      type: "text",
      text: `[DESIGNER MODE: ACTIVE v5]\n1. Read ${join("skills", "designer-master.md")} once at the start of a substantive design task.`,
    }],
  });
  const report = analyzeUsage(raw, [{ name: "designer-master", signature: BODY_LINE }]);
  assert.equal(report.rows[0].mentioned, 1);
  assert.equal(report.rows[0].read, 0);
  assert.deepEqual(report.namedNeverRead, ["designer-master"]);
  assert.deepEqual(report.read, []);
});

test("reading the body counts, and the counts are per skill", () => {
  const raw = [
    JSON.stringify({ content: [{ type: "text", text: `Read ${join("skills", "designer-master.md")} first.` }] }),
    JSON.stringify({ content: [{ type: "tool_result", text: `${BODY_LINE}\n\nthen the rest` }] }),
  ].join("\n");
  const report = analyzeUsage(raw, [
    { name: "designer-master", signature: BODY_LINE },
    { name: "animate", signature: "Motion is requested or already present, never added as decoration." },
  ]);
  assert.equal(report.rows[0].read, 1);
  assert.deepEqual(report.read, ["designer-master"]);
  assert.deepEqual(report.silent, ["animate"]);
  assert.ok(formatUsageLine(report).startsWith("skill usage: read designer-master x1"));
});

test("a skill with no usable passage is reported unmeasured, not clean", () => {
  const report = analyzeUsage(JSON.stringify({ content: "nothing relevant" }), [
    { name: "expression", signature: null },
  ]);
  assert.deepEqual(report.unmeasured, ["expression"]);
  assert.ok(formatUsageLine(report).includes("unmeasured expression"));
});

test("loadSignatures reads files and marks unreadable ones unmeasured", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-sig-"));
  try {
    const file = join(dir, "designer-master.md");
    writeFileSync(file, SKILL_FILE);
    const loaded = loadSignatures([
      { name: "designer-master", file },
      { name: "ghost", file: join(dir, "missing.md") },
    ]);
    assert.equal(loaded[0].signature, BODY_LINE);
    assert.equal(loaded[1].signature, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionDirName mirrors the host's working-directory mangling", () => {
  assert.equal(sessionDirName("G:\\bodycam-lol"), "--G--bodycam-lol--");
  assert.equal(sessionDirName("C:\\WINDOWS\\system32"), "--C--WINDOWS-system32--");
  assert.equal(sessionDirName("G:\\bodycam-lol\\"), "--G--bodycam-lol--");
});

test("locateTranscript prefers the session id and falls back to the newest transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-home-"));
  try {
    const dir = join(home, ".omp", "agent", "sessions", sessionDirName("G:\\proj"));
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "2026-01-01T00-00-00-000Z_aaaa.jsonl");
    const bound = join(dir, "2026-01-02T00-00-00-000Z_session-xyz.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(bound, "{}\n");

    const byId = locateTranscript({
      sessionId: "session-xyz",
      cwd: "G:\\proj",
      root: join(home, ".omp", "agent", "sessions"),
    });
    assert.equal(byId.path, bound);
    assert.equal(byId.reason, null);

    const byTime = locateTranscript({
      sessionId: "unknown-id",
      cwd: "G:\\proj",
      sinceMs: 1,
      root: join(home, ".omp", "agent", "sessions"),
    });
    assert.equal(byTime.path, bound, "newest transcript at or after the session start should win");

    const missing = locateTranscript({
      sessionId: "unknown-id",
      cwd: "G:\\elsewhere",
      root: join(home, ".omp", "agent", "sessions"),
    });
    assert.equal(missing.path, null);
    assert.equal(missing.reason, "session-directory-not-found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectSkillUsage reports a reason instead of a clean result when nothing resolves", () => {
  const report = collectSkillUsage({
    sessionId: "nope",
    cwd: "G:\\nowhere",
    skills: [{ name: "designer-master", signature: BODY_LINE }],
    root: join(tmpdir(), "usage-empty-root"),
  });
  assert.equal(report.reason, "session-directory-not-found");
  assert.equal(formatUsageLine(report), "skill usage: unmeasured (session-directory-not-found)");
});

test("collectSkillUsage measures a real transcript end to end", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-e2e-"));
  try {
    const cwd = "G:\\proj";
    const dir = join(home, ".omp", "agent", "sessions", sessionDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const skillFile = join(home, "designer-master.md");
    writeFileSync(skillFile, SKILL_FILE);
    writeFileSync(join(dir, "2026-01-02T00-00-00-000Z_session-abc.jsonl"), [
      JSON.stringify({ content: [{ type: "text", text: `Read ${skillFile} first.` }] }),
      JSON.stringify({ content: [{ type: "tool_result", text: BODY_LINE }] }),
    ].join("\n"));

    const report = collectSkillUsage({
      sessionId: "session-abc",
      cwd,
      sinceMs: 0,
      skills: [{ name: "designer-master", file: skillFile }],
      root: join(home, ".omp", "agent", "sessions"),
    });
    assert.equal(report.reason, null);
    assert.equal(report.rows[0].read, 1);
    assert.equal(report.rows[0].mentioned, 1);
    assert.deepEqual(report.read, ["designer-master"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mentionCount counts both the bare name and the skills/ path form", () => {
  const text = "see designer-master.md and also skills/designer-master for detail";
  assert.equal(mentionCount(text, "designer-master"), 2);
  assert.equal(mentionCount(text, "animate"), 0);
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
  }
}

if (failed > 0) process.exit(1);
console.log(`\n${cases.length} skill-usage checks passed`);
