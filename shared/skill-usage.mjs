/**
 * Skill-usage evidence for omp-designer v5.
 *
 * Why this exists: v4 enforced skill reads with a hard gate (content hashing,
 * ordering, deny-by-default tool blocking). v5 removed it because the gate
 * measured ritual completion rather than interface quality. That removal was
 * correct, but it also deleted the only signal about whether the injected
 * prompt's skill reads ever happen, so the original problem ("the agent never
 * read designer-master") became unobservable.
 *
 * This module restores the measurement and nothing else: no gate, no tool
 * interception, no state machine. It parses the transcript the host already
 * wrote when the session stops and reports which skill bodies actually appeared
 * in it.
 *
 * Measurement rule: a filename mention is not a read. The injected prompt names
 * every skill file, so counting path mentions counts the instruction, not the
 * action. A skill counts as read only when a distinctive passage of its own body
 * is present in the transcript. Both numbers are reported, because the gap
 * between them ("named four times, never opened") is the finding.
 *
 * Transcript text is unwrapped by parsing each JSONL record and collecting its
 * strings, never by matching raw bytes: the recorded form escapes newlines as
 * `\n` and quotes as `\"`, so a byte-level search for a multi-line passage
 * silently misses every real read and reports a false negative.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const MIN_SIGNATURE_CHARS = 60;

/**
 * @typedef {{ name: string, file?: string | null, signature?: string | null }} Skill
 * @typedef {{ sessionId?: string, cwd?: string, sinceMs?: number, skills?: Skill[], root?: string, readFile?: (path: string, encoding: string) => string }} UsageOptions
 */

/** Fold runs of whitespace so a passage matches regardless of reflow or indent. */
export function normalizePassage(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Pick a distinctive passage from a skill body.
 *
 * The first non-heading, non-empty line long enough to be unique is chosen
 * deterministically, so two runs over the same skill file always measure the
 * same passage. Returns null when the file has no usable passage; the report
 * then marks that skill unmeasured instead of claiming a clean result.
 */
export function skillSignature(text) {
  const body = String(text ?? "").replace(FRONTMATTER_RE, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("#"))
    .filter((line) => !/^[-*|>`]+$/.test(line));
  const distinctive = lines.find((line) => line.length >= MIN_SIGNATURE_CHARS);
  if (distinctive) return normalizePassage(distinctive);
  const longest = lines.slice().sort((a, b) => b.length - a.length)[0];
  return longest && longest.length >= MIN_SIGNATURE_CHARS ? normalizePassage(longest) : null;
}

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) collectStrings(value[key], out);
  }
}

/**
 * Flatten a raw JSONL transcript into searchable text.
 *
 * Every record is parsed and its strings collected, which unwraps the recorded
 * escaping. A record that is not valid JSON contributes its own bytes so a
 * partially written transcript still yields evidence instead of nothing.
 */
export function transcriptText(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    collectStrings(parsed, out);
  }
  return out.join("\n");
}

/** Count non-overlapping occurrences of a normalized passage in a haystack. */
export function countOccurrences(haystack, passage) {
  const needle = normalizePassage(passage);
  if (needle === "") return 0;
  const text = normalizePassage(haystack);
  if (text === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** How often the transcript names this skill (prompt instruction or model echo). */
export function mentionCount(text, name) {
  return countOccurrences(text, `${name}.md`) + countOccurrences(text, `skills/${name}`);
}

/**
 * Read each skill once and derive its signature. A missing or unreadable skill
 * is marked with `signature: null` rather than dropped.
 * @param {Skill[]} skills
 * @param {(path: string, encoding: string) => string} [readFile]
 */
export function loadSignatures(skills, readFile = readFileSync) {
  return skills.map((skill) => {
    let signature = skill.signature ?? null;
    if (signature === null && typeof skill.file === "string" && existsSync(skill.file)) {
      try {
        signature = skillSignature(readFile(skill.file, "utf8"));
      } catch {
        signature = null;
      }
    }
    return { name: skill.name, file: skill.file ?? null, signature };
  });
}

/** Directory name the host derives from a working directory. */
export function sessionDirName(cwd) {
  const trimmed = String(cwd ?? "").replace(/[\\/]+$/, "");
  return `--${trimmed.replace(/[:\\/]/g, "-")}--`;
}

export function sessionsRoot(home = homedir()) {
  return join(home, ".omp", "agent", "sessions");
}

/**
 * Find the transcript for a session.
 *
 * A filename containing the host session id wins. Otherwise the newest
 * transcript in the working directory's session folder at or after the session
 * start is used, which is the fallback case where the host supplies no id. When
 * neither resolves, the reason is reported instead of an empty success.
 */
/**
 * @param {UsageOptions} [options]
 */
export function locateTranscript({ sessionId, cwd, sinceMs = 0, root = sessionsRoot() } = {}) {
  const dir = join(root, sessionDirName(cwd));
  if (!existsSync(dir)) return { path: null, dir, reason: "session-directory-not-found" };
  let entries;
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"));
  } catch {
    return { path: null, dir, reason: "session-directory-unreadable" };
  }
  if (entries.length === 0) return { path: null, dir, reason: "no-transcripts" };

  if (typeof sessionId === "string" && sessionId !== "") {
    const bound = entries.filter((entry) => entry.includes(sessionId));
    if (bound.length === 1) return { path: join(dir, bound[0]), dir, reason: null };
  }

  const candidates = entries
    .map((entry) => {
      try {
        return { entry, mtime: statSync(join(dir, entry)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item) => item !== null)
    .filter((item) => item.mtime >= sinceMs - 1000)
    .sort((a, b) => (b.mtime - a.mtime) || (b.entry < a.entry ? -1 : b.entry > a.entry ? 1 : 0));
  if (candidates.length === 0) return { path: null, dir, reason: "transcript-not-found" };
  return { path: join(dir, candidates[0].entry), dir, reason: null };
}

function buildRows(body, loaded) {
  return loaded.map((skill) => {
    const mentioned = mentionCount(body, skill.name);
    const read = skill.signature ? countOccurrences(body, skill.signature) : 0;
    return { name: skill.name, mentioned, read, measured: Boolean(skill.signature) };
  });
}

function summarize(rows) {
  return {
    read: rows.filter((row) => row.read > 0).map((row) => row.name),
    namedNeverRead: rows
      .filter((row) => row.read === 0 && row.mentioned > 0)
      .map((row) => row.name),
    silent: rows
      .filter((row) => row.read === 0 && row.mentioned === 0)
      .map((row) => row.name),
    unmeasured: rows.filter((row) => !row.measured).map((row) => row.name),
  };
}

/** One compact line for a trace record, the doctor report, or a console print. */
export function formatUsageLine(report) {
  const parts = [];
  const read = report.rows.filter((row) => row.read > 0);
  if (read.length > 0) {
    parts.push(`read ${read.map((row) => `${row.name} x${row.read}`).join(", ")}`);
  }
  const namedNeverRead = report.rows.filter((row) => row.read === 0 && row.mentioned > 0);
  if (namedNeverRead.length > 0) {
    parts.push(`named-never-read ${namedNeverRead.map((row) => `${row.name} x${row.mentioned}`).join(", ")}`);
  }
  const silent = report.rows.filter((row) => row.read === 0 && row.mentioned === 0);
  if (silent.length > 0) parts.push(`silent ${silent.map((row) => row.name).join(", ")}`);
  const unmeasured = report.rows.filter((row) => !row.measured);
  if (unmeasured.length > 0) parts.push(`unmeasured ${unmeasured.map((row) => row.name).join(", ")}`);
  const detail = parts.length > 0 ? parts.join("; ") : "no skills in manifest";
  return report.reason ? `skill usage: unmeasured (${report.reason})` : `skill usage: ${detail}`;
}

/**
 * Analyze an already-read transcript (no file access).
 * @param {string} rawTranscript
 * @param {Skill[]} skills
 */
export function analyzeUsage(rawTranscript, skills) {
  const body = transcriptText(rawTranscript);
  const rows = buildRows(body, skills);
  const report = { transcript: null, reason: null, rows, ...summarize(rows) };
  return { ...report, line: formatUsageLine(report) };
}

/**
 * End-to-end evidence collection: locate the transcript, read it, and report the
 * per-skill counts. Never throws for a missing transcript — that is a reason,
 * not a clean result.
 */
/**
 * @param {UsageOptions} [options]
 */
export function collectSkillUsage({ sessionId, cwd, sinceMs = 0, skills = [], root, readFile = readFileSync } = {}) {
  const located = locateTranscript({ sessionId, cwd, sinceMs, root });
  const loaded = loadSignatures(skills, readFile);
  if (!located.path) {
    const rows = loaded.map((skill) => ({ name: skill.name, mentioned: 0, read: 0, measured: Boolean(skill.signature) }));
    const report = { transcript: null, dir: located.dir, reason: located.reason, rows, ...summarize(rows) };
    return { ...report, line: formatUsageLine(report) };
  }
  const raw = readFile(located.path, "utf8");
  const body = transcriptText(raw);
  const rows = buildRows(body, loaded);
  const report = { transcript: located.path, dir: located.dir, reason: null, rows, ...summarize(rows) };
  return { ...report, line: formatUsageLine(report) };
}
