/**
 * Delivery-claim checking for omp-designer v5.
 *
 * Why this exists: the delivery checks verify the project, never the sentence
 * the model ships with it. A session can pass every check and still end with
 * "opened the screenshots and verified both viewports" when the project holds no
 * capture and the page was never opened. The claude-code harness gets this class
 * of honesty from artifact diagnostics it owns; a local project has no artifact
 * the harness owns, so the check here is narrower and deterministic: compare the
 * claims the summary makes about its own verification against the facts the
 * stop-time record already holds.
 *
 * Two rules, both anchored to a recorded fact:
 *
 *   claim-contradicts-check   the summary says something passed and the record
 *                             shows that check failed — a proven falsehood.
 *   claim-unverified-evidence the summary claims a verification the record
 *                             cannot support: a visual claim with no fresh
 *                             capture, or a pass claim when nothing was measured.
 *
 * Precision beats recall. A missed claim costs nothing; a false finding teaches
 * the operator to ignore the check. Three consequences are deliberate:
 *
 *   - Negated sentences are never claims. "I could not verify at 375px" is the
 *     honest thing to write and must not be punished, so any sentence carrying a
 *     negation token is skipped whole — even when that sacrifices a real claim
 *     elsewhere in the same sentence.
 *   - Absence alone is not a finding. A visual claim is only reported when the
 *     record shows a capture is missing or stale; when no visual surface changed
 *     there is nothing to compare and the claim is left alone.
 *   - No build system is not a failed build. A pass claim against a check that
 *     never ran is unsupported rather than false, and the two are reported with
 *     different words.
 *
 * This module is pure: message text and recorded facts in, findings out. No
 * filesystem, no model, no state.
 */

export const CLAIM_RULES = Object.freeze({
  contradicts: "claim-contradicts-check",
  unverified: "claim-unverified-evidence",
});

/** A claim about having looked at rendered output. */
const VISUAL_CLAIM_RE =
  /\b(?:reviewed|opened|inspected|checked|looked at|verified|validated|confirmed)\b[^.!?\n]{0,40}\b(?:screenshots?|captures?|page|site|layout|browser|viewports?|rendering|render)\b|\bvisual(?:ly)?\s(?:verified|checked|confirmed)\b|\bverified in the browser\b/i;

/** A claim that the build, tests, or checks passed. */
const PASS_CLAIM_RE =
  /\b(?:build|tests?|checks?|validation|validators?|linters?|typecheck|type-?checking)\b[^.!?\n]{0,30}\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean)\b|\ball (?:checks|tests) (?:pass|passed)\b|\bno (?:errors|warnings|failures)\b/i;

/** A sentence carrying any of these is treated as a disclaimer, not a claim. */
const NEGATION_RE =
  /\b(?:not|never|no|none|cannot|can't|couldn't|could not|didn't|did not|unable|without|failed|failing|skipped|unverified|not measured)\b/i;

/**
 * Split a summary into claim-sized units. Bullets usually carry no terminal
 * punctuation, so newlines are boundaries in their own right.
 */
function sentences(text) {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[\s>*\-+\d.()]+/, "").trim())
    .filter((line) => line.length > 0);
}

function quote(sentence) {
  const trimmed = sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
  return `"${trimmed}"`;
}

/**
 * @param {{
 *   message?: string,
 *   evidence?: { state?: string, found?: number, stale?: number },
 *   buildOk?: boolean | null,
 * }} input
 *   `buildOk` is the recorded build/results check: true passed, false failed,
 *   null when it was skipped (no build system) or never reported.
 * @returns {Array<{ rule: string, detail: string }>}
 */
export function claimFindings({ message = "", evidence = {}, buildOk = null } = {}) {
  const findings = [];
  const state = String(evidence.state ?? "none");
  let visualReported = false;
  let passReported = false;

  for (const sentence of sentences(message)) {
    if (NEGATION_RE.test(sentence)) continue;

    if (!visualReported && VISUAL_CLAIM_RE.test(sentence) && (state === "missing" || state === "stale")) {
      visualReported = true;
      findings.push({
        rule: CLAIM_RULES.unverified,
        detail: state === "stale"
          ? `The summary claims a look at the rendered page, but every capture in the project predates the latest source edit, so no capture shows the shipped result. ${quote(sentence)} Recapture after the final change, then make the claim again.`
          : `The summary claims a look at the rendered page, but the project holds no capture for a visual change made this session, so the record cannot support the claim. ${quote(sentence)} Save the full-page capture you reviewed with the project, or state what was actually checked.`,
      });
      continue;
    }

    if (!passReported && PASS_CLAIM_RE.test(sentence)) {
      if (buildOk === false) {
        passReported = true;
        findings.push({
          rule: CLAIM_RULES.contradicts,
          detail: `The summary says it passed while the recorded check failed. ${quote(sentence)} Report the failure, or fix it and rerun before restating it as passing.`,
        });
        continue;
      }
      if (buildOk === null && state !== "missing" && state !== "stale") {
        passReported = true;
        findings.push({
          rule: CLAIM_RULES.unverified,
          detail: `The summary claims a passing build or test run, but nothing of the kind was measured for this project. ${quote(sentence)} Name the command that actually ran, or drop the claim.`,
        });
      }
    }
  }

  return findings;
}
