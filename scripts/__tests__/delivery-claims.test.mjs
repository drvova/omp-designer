#!/usr/bin/env node
/**
 * Delivery-claim checking: the comparison between what a session's final message
 * claims about its own verification and what the stop-time record actually holds.
 *
 * The precision cases carry the weight here. A check like this is only worth
 * keeping if an honest sentence is never punished, so the disclaimer cases (a
 * negated claim, an absence with nothing to compare against) are pinned as hard
 * as the true positives.
 */
import assert from "node:assert/strict";
import { CLAIM_RULES, claimFindings } from "../../shared/delivery-claims.mjs";

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
};

const rules = (findings) => findings.map((finding) => finding.rule);

ok("a visual claim with no capture is unverified evidence", () => {
  const findings = claimFindings({
    message: "Opened the screenshots and verified both viewports before shipping.",
    evidence: { state: "missing", found: 0, stale: 0 },
  });
  assert.deepEqual(rules(findings), [CLAIM_RULES.unverified]);
  assert.match(findings[0].detail, /no capture/);
  assert.match(findings[0].detail, /Opened the screenshots/);
});

ok("a visual claim against stale captures is unverified evidence", () => {
  const findings = claimFindings({
    message: "I reviewed the page rendering at 375px.",
    evidence: { state: "stale", found: 2, stale: 2 },
  });
  assert.deepEqual(rules(findings), [CLAIM_RULES.unverified]);
  assert.match(findings[0].detail, /predates the latest source edit/);
});

ok("a visual claim backed by a fresh capture is not a finding", () => {
  assert.deepEqual(
    claimFindings({
      message: "Reviewed the screenshots at both viewports.",
      evidence: { state: "fresh", found: 1, stale: 0 },
    }),
    [],
  );
});

ok("an absence with nothing to compare is not a finding", () => {
  // No capture and no visual change this session: the claim cannot be refuted,
  // and nagging on it is exactly the false positive that kills a check.
  assert.deepEqual(
    claimFindings({
      message: "Verified the page in the browser.",
      evidence: { state: "none", found: 0, stale: 0 },
    }),
    [],
  );
});

ok("a pass claim against a failed check contradicts the record", () => {
  const findings = claimFindings({
    message: "The build passes and everything is wired up.",
    evidence: { state: "fresh", found: 1, stale: 0 },
    buildOk: false,
  });
  assert.deepEqual(rules(findings), [CLAIM_RULES.contradicts]);
  assert.match(findings[0].detail, /recorded check failed/);
});

ok("a pass claim against nothing measured is unverified, not false", () => {
  const findings = claimFindings({
    message: "Tests pass.",
    evidence: { state: "fresh", found: 1, stale: 0 },
    buildOk: null,
  });
  assert.deepEqual(rules(findings), [CLAIM_RULES.unverified]);
  assert.match(findings[0].detail, /nothing of the kind was measured/);
});

ok("a pass claim backed by a passing check is not a finding", () => {
  assert.deepEqual(
    claimFindings({
      message: "Build passes, checks are green.",
      evidence: { state: "fresh", found: 1, stale: 0 },
      buildOk: true,
    }),
    [],
  );
});

ok("a negated sentence is a disclaimer, never a claim", () => {
  const disclaimers = [
    "I could not verify this in the browser or at 375px.",
    "The build was not run, so its status is unknown.",
    "No screenshots were reviewed because no browser was available.",
  ];
  for (const message of disclaimers) {
    assert.deepEqual(
      claimFindings({ message, evidence: { state: "missing", found: 0, stale: 0 }, buildOk: null }),
      [],
      `should not flag: ${message}`,
    );
  }
});

ok("each rule reports at most one finding per message", () => {
  const findings = claimFindings({
    message: [
      "I verified the page in the browser.",
      "I also reviewed the screenshots after the change.",
      "The build passes as well.",
    ].join("\n"),
    evidence: { state: "missing", found: 0, stale: 0 },
    buildOk: false,
  });
  assert.deepEqual(rules(findings), [CLAIM_RULES.unverified, CLAIM_RULES.contradicts]);
});

ok("an empty or missing message yields nothing", () => {
  assert.deepEqual(claimFindings({}), []);
  assert.deepEqual(claimFindings({ message: "", evidence: {} }), []);
});

console.log(`\n${checks} claim checks passed`);
