#!/usr/bin/env node
/**
 * The workshop's way back.
 *
 * The loop is only real if a click on the page changes what the next turn is
 * told. Three seams can each fail silently and leave the reader clicking a
 * button that does nothing:
 *
 *   1. the question block — a plan the model wrote by hand has to parse, and a
 *      malformed one must say so instead of offering a decision that cannot be
 *      recorded;
 *   2. the endpoint — a POST has to land in the project's decision log, and a
 *      POST naming an option that is not on the page must not;
 *   3. the hand-off — the extension reads what is new, injects it once, and never
 *      repeats a decision it already applied.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSHOP_DECISIONS_FILE,
  pendingDecisions,
  readDecisions,
  readOpenQuestion,
  recordDecision,
  renderWorkshopPanel,
} from "../../shared/workshop.mjs";
import { isPageWrite, serveCanvas } from "../../shared/design-canvas.mjs";

let checks = 0;
const ok = async (label, fn) => {
  await fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const dirs = [];
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "workshop-"));
  dirs.push(dir);
  return dir;
};

const BLOCK = `# Workshop

## Open

\`\`\`json workshop
{ "question": "Pricing on the home page, or its own route?",
  "options": [
    { "id": "inline", "label": "Keep it on the home page", "detail": "one scroll, no extra route" },
    { "id": "route", "label": "Give it its own route", "detail": "room to grow" }
  ] }
\`\`\`
`;

const withPlan = (text) => {
  const dir = makeDir();
  writeFileSync(join(dir, "WORKSHOP.md"), text);
  return dir;
};

try {
  await ok("no plan document reads as nothing open, not as a crash", () => {
    const open = readOpenQuestion(makeDir());
    assert.equal(open.question, null);
    assert.match(open.problem, /no plan document/);
  });

  await ok("the question block parses into the question and its options", () => {
    const open = readOpenQuestion(withPlan(BLOCK));
    assert.equal(open.question, "Pricing on the home page, or its own route?");
    assert.deepEqual(open.options.map((option) => option.id), ["inline", "route"]);
    assert.equal(open.problem, null);
  });

  await ok("a malformed block says so instead of offering dead buttons", () => {
    const broken = withPlan("```json workshop\n{ not json ]\n```\n");
    assert.match(readOpenQuestion(broken).problem, /not valid JSON/);
    const optionless = withPlan('```json workshop\n{ "question": "Which one?" }\n```\n');
    assert.match(readOpenQuestion(optionless).problem, /at least one option/);
    const proseOnly = withPlan("# Workshop\n\nNo block here.\n");
    assert.match(readOpenQuestion(proseOnly).problem, /no question block/);
  });

  await ok("only an option on the page can be recorded, and it lands in the project", () => {
    const dir = withPlan(BLOCK);
    const stray = recordDecision(dir, { optionId: "delete-everything" });
    assert.equal(stray.ok, false);
    assert.match(stray.reason, /not one of the options/);

    const recorded = recordDecision(dir, { optionId: "route", at: "2026-10-13T10:00:00.000Z" });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.decision.label, "Give it its own route");
    const logged = JSON.parse(readFileSync(join(dir, WORKSHOP_DECISIONS_FILE), "utf8").trim());
    assert.equal(logged.optionId, "route");
    assert.equal(logged.question, "Pricing on the home page, or its own route?");
  });

  await ok("a decision is new once, and never again after it is seen", () => {
    const dir = withPlan(BLOCK);
    const first = recordDecision(dir, { optionId: "inline", at: "2026-10-13T10:01:00.000Z" }).decision;
    assert.equal(pendingDecisions(dir, []).length, 1, "unseen decisions are pending");
    assert.equal(pendingDecisions(dir, [first.id]).length, 0, "a decision already applied is not replayed");
    recordDecision(dir, { optionId: "route", at: "2026-10-13T10:02:00.000Z" });
    assert.equal(pendingDecisions(dir, [first.id]).length, 1, "the newer decision is still pending");
    assert.equal(readDecisions(dir).length, 2, "the log is append-only");
  });

  await ok("the panel renders the question, escapes what the model wrote, and closes when there is none", () => {
    const open = renderWorkshopPanel(withPlan(BLOCK));
    assert.match(open, /data-state="open"/);
    assert.match(open, /data-option="inline"/);
    assert.match(open, /Keep it on the home page/);

    const hostile = withPlan('```json workshop\n{ "question": "<img src=x onerror=alert(1)>", "options": [ { "id": "a\'b", "label": "<script>bad()</script>" } ] }\n```\n');
    const panel = renderWorkshopPanel(hostile);
    assert.doesNotMatch(panel, /<script>bad\(\)<\/script>/);
    assert.match(panel, /&lt;script&gt;/);
    assert.doesNotMatch(panel, /<img src=x/);

    const closed = renderWorkshopPanel(makeDir());
    assert.match(closed, /data-state="closed"/);
    assert.match(closed, /no plan document/);
  });

  await ok("the live server answers the question, and a click is recorded and pushed to viewers", async () => {
    const dir = withPlan(BLOCK);
    const live = await serveCanvas({ cwd: dir, port: 0 }, { log() {}, error() {} });
    try {
      const asked = await fetch(`${live.url}workshop`).then((response) => response.json());
      assert.equal(asked.question, "Pricing on the home page, or its own route?");
      assert.equal(asked.options.length, 2);

      // The page the server hands out carries the panel and the script that posts.
      const page = await fetch(live.url).then((response) => response.text());
      assert.match(page, /data-state="open"/, "the served canvas carries the open question");
      assert.match(page, /workshop\/decide/, "the served canvas carries the way back");

      const stream = await fetch(`${live.url}events`);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      await reader.read(); // the initial comment flushes the headers

      const bad = await fetch(`${live.url}workshop/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: "nope" }),
      });
      assert.equal(bad.status, 400, "an option that is not on the page is refused");
      assert.equal(readDecisions(dir).length, 0, "and nothing is written");

      const good = await fetch(`${live.url}workshop/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: "route" }),
      });
      assert.equal(good.status, 200);
      assert.equal((await good.json()).decision.optionId, "route");
      assert.equal(readDecisions(dir).length, 1, "the click landed in the project");

      let sawReload = "";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !sawReload.includes("reload")) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise((done) => setTimeout(() => done({ value: undefined }), 400)),
        ]);
        if (chunk.value) sawReload += decoder.decode(chunk.value);
      }
      assert.match(sawReload, /reload/, "an open viewer is told the decision was made");
      reader.cancel().catch(() => {});

      // The page now shows what was settled, so a reload does not invite a redo.
      const after = await fetch(live.url).then((response) => response.text());
      assert.match(after, /Give it its own route/);
    } finally {
      live.close();
    }
  });

  await ok("a refresh rebuilds on demand and reports what it laid out", async () => {
    const dir = makeDir();
    const live = await serveCanvas({ cwd: dir, port: 0 }, { log() {}, error() {} });
    try {
      const empty = live.refresh();
      assert.equal(empty, 0, "an empty project lays out nothing, and says so with a number");
      mkdirSync(join(dir, "screenshots"), { recursive: true });
      mkdirSync(join(dir, "project"), { recursive: true });
      writeFileSync(join(dir, "project", "Home.dc.html"), "<!doctype html><title>Home</title>");
      writeFileSync(join(dir, "screenshots", "desktop-1440.png"), "png");
      const boards = live.refresh();
      assert.equal(typeof boards, "number");
      assert.ok(boards >= 1, "a board written mid-session joins the canvas without a restart");
    } finally {
      live.close();
    }
  });

  await ok("only a page write counts as a page write", () => {
    assert.equal(isPageWrite("write", { file_path: "index.html" }), true);
    assert.equal(isPageWrite("edit", { path: "styles/site.css" }), true);
    assert.equal(isPageWrite("MultiEdit", { filePath: "src/App.tsx" }), true);
    assert.equal(isPageWrite("write", { file_path: "screenshots/desktop-1440.png" }), false);
    assert.equal(isPageWrite("read", { file_path: "index.html" }), false);
    assert.equal(isPageWrite("bash", { command: "echo hi > index.html" }), false);
    assert.equal(isPageWrite("write", {}), false);
  });
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} workshop-loop checks passed`);
