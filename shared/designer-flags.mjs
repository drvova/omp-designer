/**
 * Local capability flags for omp-designer.
 *
 * The claude-code harness tunes its own frontend behaviour per tenant from the
 * control plane: per-capability switches, and prompt fragments that appear only
 * when the flag is on and the sibling capability is present. omp-designer has no
 * control plane, so the equivalent is a project file plus an environment
 * variable, read once per turn at prompt-assembly time.
 *
 * Precedence, highest first:
 *   1. a flag registered with the host (`--designer-<name>`, session wide)
 *   2. `OMP_DESIGNER_FLAGS` — a JSON object in the environment (session/shell wide)
 *   3. `.omp/designer-flags.json` in the working directory (project wide)
 *   4. the defaults below (always enabled, so behaviour is unchanged by default)
 *
 * The host flags are registered without a default on purpose: the host then
 * reports `undefined` until someone actually passes one, which is the only way to
 * tell "the user turned this off" from "nobody said anything".
 *
 * Reading never throws: a missing file, unreadable file, malformed JSON, an
 * unknown key, or a value of the wrong type all fall back to the default. A typo
 * in a flag file must not be able to take the workflow down, and an unknown key
 * must never become a silent behaviour change.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Each flag gates one conditional contract fragment. `true` means the fragment
 * may be injected when the request or project warrants it; `false` suppresses it
 * regardless of the request.
 */
export const FLAG_DEFAULTS = Object.freeze({
  motion: true,
  dataviz: true,
  forms: true,
  verify: true,
  workshop: true,
});

export const FLAG_FILE = join(".omp", "designer-flags.json");
export const FLAG_ENV = "OMP_DESIGNER_FLAGS";

/**
 * The CLI name each flag answers to, so the extension and the flag reader cannot
 * drift on what `--designer-motion` means.
 */
export const FLAG_CLI_NAMES = Object.freeze({
  motion: "designer-motion",
  dataviz: "designer-dataviz",
  forms: "designer-forms",
  verify: "designer-verify",
  workshop: "designer-workshop",
});

/** One line per flag, for the host's `--help`. */
export function flagDescriptions() {
  return Object.entries(FLAG_CLI_NAMES).map(([name, cli]) => ({
    cli,
    description: `omp-designer: ${name} contract fragment (pass --${cli}=false to suppress it)`,
  }));
}

function readJsonObject(path) {
  if (!existsSync(path)) return { value: null, source: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, source: `${path} (not an object)` };
    }
    return { value: parsed, source: path };
  } catch {
    return { value: null, source: `${path} (unreadable)` };
  }
}

function readEnvObject(env) {
  const raw = env?.[FLAG_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return { value: null, source: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, source: `${FLAG_ENV} (not an object)` };
    }
    return { value: parsed, source: FLAG_ENV };
  } catch {
    return { value: null, source: `${FLAG_ENV} (unreadable)` };
  }
}

/**
 * Resolve the effective flags.
 *
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, host?: Record<string, boolean | undefined> | null }} [options]
 * @returns {{ flags: Record<string, boolean>, sources: string[], ignored: string[] }}
 */
export function resolveFlags({ cwd, env = process.env, host = null } = {}) {
  const sources = [];
  const ignored = [];
  const file = cwd ? readJsonObject(join(cwd, FLAG_FILE)) : { value: null, source: null };
  const fromEnv = readEnvObject(env);
  // A registered flag the user actually passed. Anything else on the host side
  // (`undefined`, or a value the host invented) is not a choice and is skipped.
  const hostFlags = [];
  for (const [key, value] of Object.entries(host && typeof host === "object" ? host : {})) {
    if (!Object.hasOwn(FLAG_DEFAULTS, key)) {
      if (value !== undefined) ignored.push(`${key} (host flag, unknown)`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") {
      ignored.push(`${key} (host flag, not a boolean)`);
      continue;
    }
    hostFlags.push([key, value]);
  }
  const fromHost = hostFlags.length > 0
    ? { value: Object.fromEntries(hostFlags), source: `--${hostFlags.map(([key]) => FLAG_CLI_NAMES[key] ?? key).join(" --")}` }
    : { value: null, source: null };
  const flags = { ...FLAG_DEFAULTS };

  // Lowest precedence first so a later source overwrites it.
  for (const layer of [file, fromEnv, fromHost]) {
    if (layer.source) sources.push(layer.source);
    if (!layer.value) continue;
    for (const [key, value] of Object.entries(layer.value)) {
      if (!Object.hasOwn(FLAG_DEFAULTS, key)) {
        ignored.push(key);
        continue;
      }
      if (typeof value !== "boolean") {
        ignored.push(`${key} (not a boolean)`);
        continue;
      }
      flags[key] = value;
    }
  }

  return { flags, sources, ignored };
}

/** One line for a trace or the doctor report. */
export function describeFlags({ flags, sources, ignored }) {
  const state = Object.entries(flags).map(([key, value]) => `${key}=${value ? "on" : "off"}`);
  const detail = sources.length > 0 ? ` from ${sources.join(", ")}` : " (defaults)";
  const noted = ignored.length > 0 ? ` | ignored: ${ignored.join(", ")}` : "";
  return `flags: ${state.join(" ")}${detail}${noted}`;
}
