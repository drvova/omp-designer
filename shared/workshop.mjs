/**
 * The workshop loop, carried by the project instead of by the conversation.
 *
 * claude-code's workshop publishes a plan whose decision blocks the reader clicks;
 * the choice travels back into the session through the page's own record, and the
 * next turn applies it. A local page has no channel back — until it does: the
 * canvas server already serves the project, so it can accept the click, write the
 * decision beside the work, and the extension injects it into the next turn.
 *
 * The contract between the two halves is a fenced JSON block in the plan document
 * the model writes (`WORKSHOP.md`), and an append-only decision log:
 *
 *   ```json workshop
 *   { "question": "Pricing on the home page, or its own route?",
 *     "options": [ { "id": "inline", "label": "Keep it on the home page", "detail": "…" } ] }
 *   ```
 *
 * Pure functions here; the server and the extension are thin callers.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const WORKSHOP_PLAN_FILES = Object.freeze(["WORKSHOP.md", "workshop.md"]);
export const WORKSHOP_STATE_DIR = join(".designer");
export const WORKSHOP_DECISIONS_FILE = join(WORKSHOP_STATE_DIR, "workshop-decisions.jsonl");

const BLOCK_RE = /```json\s+workshop\s*\r?\n([\s\S]*?)```/;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** The plan document, if the model has written one. */
export function planPath(project) {
  for (const name of WORKSHOP_PLAN_FILES) {
    const path = join(project, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * The open question and its options.
 *
 * A malformed block reads as "no question": the panel then says so instead of
 * offering buttons that cannot be recorded.
 */
export function readOpenQuestion(project) {
  const path = planPath(project);
  if (!path) return { question: null, options: [], problem: "no plan document yet", plan: null };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { question: null, options: [], problem: "the plan document is unreadable", plan: path };
  }
  const match = BLOCK_RE.exec(text);
  if (!match) return { question: null, options: [], problem: "no question block in the plan", plan: path };
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { question: null, options: [], problem: "the question block is not valid JSON", plan: path };
  }
  const options = Array.isArray(parsed?.options)
    ? parsed.options
        .filter((option) => option && typeof option === "object" && typeof option.id === "string")
        .map((option) => ({
          id: String(option.id),
          label: typeof option.label === "string" ? option.label : String(option.id),
          detail: typeof option.detail === "string" ? option.detail : "",
        }))
    : [];
  if (typeof parsed?.question !== "string" || parsed.question.trim() === "" || options.length === 0) {
    return { question: null, options: [], problem: "the question block needs a question and at least one option", plan: path };
  }
  return { question: parsed.question.trim(), options, problem: null, plan: path };
}

/** Every decision recorded on the page, oldest first. */
export function readDecisions(project) {
  const path = join(project, WORKSHOP_DECISIONS_FILE);
  if (!existsSync(path)) return [];
  const decisions = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.optionId === "string") decisions.push(entry);
      } catch {
        // A half-written line is not a decision.
      }
    }
  } catch {
    return [];
  }
  return decisions;
}

const decisionId = (question, optionId, at) =>
  `${at}-${optionId}-${String(question).slice(0, 24).replace(/\W+/g, "-")}`;

/** Record a click. Validates against the open question so a stray POST cannot write junk. */
export function recordDecision(project, { optionId, at = new Date().toISOString() } = {}) {
  const open = readOpenQuestion(project);
  if (!open.question) return { ok: false, reason: open.problem ?? "no open question" };
  const option = open.options.find((entry) => entry.id === optionId);
  if (!option) return { ok: false, reason: `"${String(optionId)}" is not one of the options on the page` };
  const entry = {
    id: decisionId(open.question, optionId, at),
    question: open.question,
    optionId: option.id,
    label: option.label,
    detail: option.detail,
    at,
  };
  mkdirSync(join(project, WORKSHOP_STATE_DIR), { recursive: true });
  appendFileSync(join(project, WORKSHOP_DECISIONS_FILE), `${JSON.stringify(entry)}\n`);
  return { ok: true, decision: entry };
}

/**
 * Decisions the session has not been told about yet.
 *
 * `seenIds` is what the extension already injected; anything else is new, which is
 * what makes the loop survive a restart without replaying old answers.
 */
export function pendingDecisions(project, seenIds = []) {
  const seen = new Set(seenIds);
  return readDecisions(project).filter((entry) => !seen.has(entry.id));
}

/** The panel the canvas renders: the open question, its options, and what was settled. */
export function renderWorkshopPanel(project) {
  const open = readOpenQuestion(project);
  const decisions = readDecisions(project);
  const settled = decisions.length > 0
    ? `<ul class="settled">${decisions.slice(-4).map((entry) => `<li>${escapeHtml(entry.label)}</li>`).join("")}</ul>`
    : "";

  if (!open.question) {
    return `<section class="workshop" data-state="closed">
  <h2>Workshop</h2>
  <p class="note">${escapeHtml(open.problem ?? "Nothing open right now.")}</p>
  ${settled}
</section>`;
  }

  const buttons = open.options
    .map((option) => `    <button type="button" class="option" data-option="${escapeHtml(option.id)}">
      <strong>${escapeHtml(option.label)}</strong>${option.detail ? `<span>${escapeHtml(option.detail)}</span>` : ""}
    </button>`)
    .join("\n");

  return `<section class="workshop" data-state="open">
  <h2>${escapeHtml(open.question)}</h2>
  <div class="options">
${buttons}
  </div>
  <p class="note">Choosing here writes the decision beside the project; the next turn applies it.</p>
  ${settled}
</section>`;
}

/** The styles and script the panel needs, injected by the canvas renderer. */
export const WORKSHOP_PANEL_STYLE = `
.workshop { position: sticky; bottom: 0; z-index: 3; background: #171717; border-top: 1px solid #2a2a2a; padding: 14px 20px; }
.workshop h2 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.workshop .options { display: flex; gap: 10px; flex-wrap: wrap; }
.workshop .option { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 260px; text-align: left; padding: 8px 12px; }
.workshop .option span { color: #9a9a9a; font-size: 12px; }
.workshop .note { color: #8d8d8d; margin: 10px 0 0; }
.workshop .settled { margin: 8px 0 0; padding-left: 18px; color: #b9b9b9; }
.workshop button[disabled] { opacity: .6; cursor: default; }
`;

export const WORKSHOP_PANEL_SCRIPT = `
const panel = document.querySelector(".workshop");
if (panel && panel.dataset.state === "open") {
  for (const button of panel.querySelectorAll(".option")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("workshop/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionId: button.dataset.option }),
        });
        const body = await response.json();
        if (!body.ok) throw new Error(body.reason || "the decision was not recorded");
      } catch (error) {
        button.disabled = false;
        const note = panel.querySelector(".note");
        if (note) note.textContent = "Could not record that: " + error.message;
      }
    });
  }
}
`;

/** List the workshop plan files that exist, for the doctor. */
export function workshopFiles(project) {
  try {
    return readdirSync(project).filter((name) => WORKSHOP_PLAN_FILES.includes(name))
      .map((name) => {
        const path = join(project, name);
        try {
          return { name, bytes: statSync(path).size };
        } catch {
          return { name, bytes: 0 };
        }
      });
  } catch {
    return [];
  }
}
