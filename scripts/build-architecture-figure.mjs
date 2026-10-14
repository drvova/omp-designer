#!/usr/bin/env node
/**
 * The architecture figure in the README, built as a real object.
 *
 * The concept: omp-designer is a **projection bench**. A turn is a contract
 * printed onto a light table: the paper comes off a roll, passes five stencil
 * plates (the five conditional fragments, swung in and out of the lamp's beam by
 * a selector), the nine lenses in the rack are the nine skills, and the beam
 * lands on the sheet the session is working on. A camera carriage on rails
 * photographs that sheet at two scales (1440 and 375) and the prints hang on the
 * drying line — the canvas. A keypad and a length of punched tape carry the
 * reader's decision back to the roll, and the dial gauge is the check verdict.
 *
 * Built with the anatomy kit (isometric SVG, four-tone shading, painter's order).
 * Static on purpose: a README image runs no JavaScript, so this is one standalone
 * SVG per theme, not a WebGL scene. Three.js and friends in the FGL catalogue all
 * need a live WebGL context; nothing in the catalogue draws a static isometric
 * plate, and that is what the deliverable actually is.
 *
 *   node scripts/build-architecture-figure.mjs            # docs/architecture.svg
 *   node scripts/build-architecture-figure.mjs --light    # docs/architecture-light.svg
 *   node scripts/build-architecture-figure.mjs --page     # + a page for the line check
 *
 * Needs the `anatomy` skill's kit on this machine. Point ANATOMY_KIT at it if it
 * lives somewhere else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const KIT_DIR = process.env.ANATOMY_KIT
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".agents", "skills", "anatomy", "kit");

const load = (name) => import(new URL(`file:///${join(KIT_DIR, name).replace(/\\/g, "/")}`).href);
const k = await load("iso-kit.mjs")
  .catch((error) => {
    throw new Error(`anatomy kit not found at ${KIT_DIR} (set ANATOMY_KIT): ${error.message}`);
  });
const lathe = await load("lathe.mjs");

const theme = process.argv.includes("--light") ? "light" : "dark";
const WIDTH = 1040;
const HEIGHT = 680;

// ---------------------------------------------------------------- world layout
// x runs left to right, y runs into the scene (negative is the back), z is up.
const PLATE = { x: -156, y: -86, w: 312, d: 132, r: 13 };
const PLATE_H = 13;
const FOOT_H = 6;

// the lamp: two posts carrying a housing whose beam falls through the stencils
const LAMP_POSTS = [[-104, -66], [-40, -66]];
const LAMP_TOP = 168;
const LAMP_BOX = { x: -112, y: -80, w: 84, d: 30, r: 4 };
const LAMP_Z = 136;
const LAMP_H = 22;

// the stencil rack: five plates on one pivot bar, the live one in the beam
const STENCIL_BAR_Z = 126;
const STENCIL_X0 = -106;
const STENCIL_PITCH = 18;
const STENCIL_W = 13;
const STENCIL_D = 3;
const STENCIL_H = 54;
const STENCIL_LIVE = 2; // the fragment currently in the light path

// the lens rack: nine drums, the chosen skill lifted
const RACK = { x: -2, y: -72, w: 116, d: 24, r: 3 };
const RACK_Z = 112;
const DRUM_R = 7;
const DRUM_H = 15;
const DRUM_LIVE = 4;

// the light table: the sheet the turn is being worked on
const TABLE = { x: -96, y: -26, w: 176, d: 104, r: 8 };
const TABLE_Z = 62;
const TABLE_H = 9;
const SHEET = { x: -80, y: -14, w: 144, d: 70, r: 3 };

// the camera carriage on its rails, facing the sheet
const RAILS = [
  { x: 106, y: -40, w: 5, d: 74, r: 2 },
  { x: 136, y: -40, w: 5, d: 74, r: 2 },
];
const CARRIAGE = { x: 101, y: -34, w: 46, d: 32, r: 3 };
const CARRIAGE_Z = 52;
const CARRIAGE_H = 30;

// the drying line: two prints, clipped, which is the canvas
const LINE_POSTS = [[44, -86], [140, -86]];
const LINE_Z = 146;
const PRINTS = [
  { x: 58, z: 74, w: 34, h: 42 },
  { x: 100, z: 82, w: 26, h: 32 },
];

// the keypad and the tape that carries the decision back to the roll
const KEYPAD = { x: -118, y: 4, w: 58, d: 30, r: 3 };
const KEYPAD_Z = 78;
const KEYPAD_H = 9;
const TAPE_SPOOL = [-84, -18];

// the dial: the check verdict
const GAUGE_POST = [138, 30];
const GAUGE_Z = 88;
const GAUGE_R = 26;
const GAUGE_H = 12;

// the paper roll: the contract, and where the tape's loop returns
const ROLL_POSTS = [[-138, -38], [-138, 12]];
const ROLL_Z = 74;
const ROLL_R = 20;
const ROLL_H = 34;

// ------------------------------------------------------------------- projection
const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [-104, -66, LAMP_TOP + 4],
    [150, -92, LINE_Z + 6],
    [138, 30, GAUGE_Z + GAUGE_H + 6],
    [-138, 12, ROLL_Z + ROLL_R],
    [150, 30, KEYPAD_Z],
  ],
  WIDTH,
  HEIGHT,
  { pad: 30, azimuth: 42, elevation: 31 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const depth = (x, y) => k.depthOf([x, y, 0], P);
const backToFront = (items) => [...items].sort((a, b) => depth(a[0], a[1]) - depth(b[0], b[1]));

/** A flat panel standing up: a rectangle in the x-z plane, extruded along y.
 *  `lathe.prismOf` takes any axis, so the frame is the y axis and the (u, v)
 *  plane is (-x, z). */
function panel({ x0, x1, z0, z1 }, y, thick = 1.4) {
  const F = lathe.frameAlong([0, 0, 0], [0, 1, 0]);
  return lathe.prismOf(F, [[-x1, z0], [-x0, z0], [-x0, z1], [-x1, z1]], y - thick, y + thick, P);
}

/** A flat inlay seen from above: paper colour and an outline, nothing else. */
function flatPiece(d, { tone = "lo", crease = "none", lit = false } = {}) {
  return S({ fill: d, shades: [], top: d, outline: "" }, { flat: true, tone, crease, lit });
}

// ------------------------------------------------------------------ the base
function base() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of backToFront(k.corners(PLATE, 26))) {
    out.push(S(k.cylinder(x, y, 8, -PLATE_H - FOOT_H, 2, P, 26), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 6, -PLATE_H - FOOT_H + 2, FOOT_H - 2, P, 26), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 6), 0, P), { tone: "lo" }));

  const screws = k.corners(PLATE, 12);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));

  // a ruler strip along the front edge, ticks hanging from its inner edge
  const strip = { x: -150, y: PLATE.y + PLATE.d - 17, w: 300, d: 8, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.7, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 5, strip.x + strip.w - 5, 5, 5, strip.y + 1, 0.7, [2.2, 4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 3, strip.y + 4, 0.7]), at([strip.x + strip.w - 3, strip.y + 4, 0.7])], { size: 0.45 }));

  // the engraved name plate, with the three rule lines that stand for its text
  const plate = { x: -166, y: -92, w: 96, d: 20, r: 2 };
  out.push(S(k.slabOf(plate, 0, 1, P, 3), { tone: "lo", crease: "faint" }));
  out.push(L(k.planOutline(plate, 1, P), { tone: "lo" }));
  out.push(D(k.corners(plate, 4).map(([x, y]) => at([x, y, 1])), { size: 0.4 }));
  for (const [index, width] of [78, 62, 44].entries()) {
    const y = plate.y + 5 + index * 4.6;
    out.push(L(k.lineOnTop([plate.x + 6, y], [plate.x + 6 + width, y], 1, P), { tone: index === 0 ? "mid" : "lo", free: true }));
  }
  return out.join("");
}

// ------------------------------------------------------------- roll and lenses
function paperRoll() {
  const out = [];
  for (const [x, y] of backToFront(ROLL_POSTS)) {
    out.push(S(k.slabOf({ x: x - 6, y: y - 6, w: 12, d: 12, r: 2 }, 0, ROLL_Z - ROLL_R + 4, P, 4, 0.6), { tone: "mid" }));
    out.push(S(k.cylinder(x, y, 5, ROLL_Z - ROLL_R + 4, 8, P, 20), { tone: "mid" }));
    out.push(D([at([x, y, ROLL_Z - ROLL_R + 12])], { size: 0.45 }));
  }
  out.push(S(k.cylinder(-138, -13, ROLL_R, ROLL_Z - ROLL_H / 2, ROLL_H, P, 28), { tone: "hi" }));
  out.push(S(k.cylinder(-138, -13, ROLL_R + 2.5, ROLL_Z - ROLL_H / 2, 2, P, 28), { tone: "lo" }));
  out.push(S(k.cylinder(-138, -13, ROLL_R + 2.5, ROLL_Z + ROLL_H / 2 - 2, 2, P, 28), { tone: "lo" }));
  out.push(L(k.ring(-138, -13, ROLL_R, ROLL_Z + ROLL_H / 2, P, 28), { tone: "lo" }));
  out.push(L(k.knurl(-138, -13, ROLL_R + 2.5, ROLL_Z - ROLL_H / 2 + 2, ROLL_Z + ROLL_H / 2 - 2, 28, P, 1.2), { tone: "faint" }));
  // the paper leaves the roll and runs to the table, drawn as two edges
  for (const y of [-12 - 14, -12 + 14]) {
    out.push(L(k.pathOf([at([-138, y, ROLL_Z - ROLL_H / 2 + 6]), at([-120, y, ROLL_Z - 26]), at([-96, y, TABLE_Z + TABLE_H + 1])]), { tone: "mid", free: true }));
  }
  // the tension arm and guide roller that hold the paper against the table
  const arm = [-120, -13];
  out.push(S(k.slabOf({ x: arm[0] - 4, y: arm[1] - 4, w: 8, d: 8, r: 1.5 }, 0, ROLL_Z + 4, P, 3, 0.4), { tone: "mid" }));
  out.push(L(k.pathOf([at([arm[0], arm[1], ROLL_Z + 4]), at([arm[0] + 6, arm[1], ROLL_Z + 26])]), { tone: "mid" }));
  out.push(S(k.cylinder(arm[0] + 6, arm[1], 4.5, ROLL_Z + 26, 24, P, 20), { tone: "hi" }));
  out.push(L(k.ring(arm[0] + 6, arm[1], 4.5, ROLL_Z + 50, P, 20), { tone: "mid" }));
  out.push(S(k.cylinder(arm[0] + 6, arm[1] + 9, 3, ROLL_Z + 34, 14, P, 18), { tone: "lo" }));
  out.push(D([at([arm[0] + 6, arm[1], ROLL_Z + 50])], { size: 0.42 }));
  return out.join("");
}

function lensRack() {
  const out = [];
  out.push(S(k.slabOf(RACK, RACK_Z - 8, 8, P, 6, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(RACK, 3), RACK_Z, P), { tone: "lo" }));
  const count = 9;
  const gap = (RACK.w - 24) / (count - 1);
  for (let index = 0; index < count; index += 1) {
    const x = RACK.x + 12 + index * gap;
    const y = RACK.y + RACK.d / 2;
    const lift = index === DRUM_LIVE ? 5 : 0;
    const z0 = RACK_Z + lift;
    out.push(S(k.cylinder(x, y, DRUM_R, z0, DRUM_H, P, 26), { tone: index === DRUM_LIVE ? "hi" : "mid" }));
    out.push(S(k.cylinder(x, y, DRUM_R + 1.4, z0 + DRUM_H - 2.4, 2.4, P, 26), { tone: index === DRUM_LIVE ? "hi" : "lo", lit: index === DRUM_LIVE }));
    out.push(L(k.ring(x, y, DRUM_R + 1.4, z0 + DRUM_H, P, 26), { tone: "lo" }));
    out.push(D([at([x, y, z0 + DRUM_H])], { size: 0.4 }));
  }
  const knob = [RACK.x + RACK.w / 2, RACK.y - 6];
  out.push(S(k.cylinder(knob[0], knob[1], 5.5, RACK_Z - 8, 12, P, 24), { tone: "mid" }));
  out.push(L(k.knurl(knob[0], knob[1], 5.5, RACK_Z - 6, RACK_Z + 2, 24, P, 1), { tone: "faint" }));
  out.push(D([at([knob[0], knob[1], RACK_Z + 4])], { size: 0.45 }));
  return out.join("");
}

// ---------------------------------------------------------------- lamp + light
function lamp() {
  const out = [];
  for (const [x, y] of backToFront(LAMP_POSTS)) {
    out.push(S(k.slabOf({ x: x - 7, y: y - 7, w: 14, d: 14, r: 2 }, 0, LAMP_TOP, P, 4, 0.6), { tone: "mid" }));
    out.push(L(k.planOutline({ x: x - 5, y: y - 5, w: 10, d: 10, r: 1 }, LAMP_TOP, P), { tone: "lo" }));
    out.push(D([at([x, y, LAMP_TOP])], { size: 0.45 }));
  }
  out.push(S(k.slabOf({ x: LAMP_POSTS[0][0] - 7, y: -73, w: 71, d: 14, r: 2 }, LAMP_TOP, 6, P, 4, 0.5), { tone: "mid" }));
  // cross bracing, so the frame is a frame and not two planks
  for (const z of [46, 92]) {
    out.push(L(k.pathOf([at([LAMP_POSTS[0][0], -66, z]), at([LAMP_POSTS[1][0], -66, z + 30])]), { tone: "lo" }));
    out.push(L(k.pathOf([at([LAMP_POSTS[0][0], -66, z + 30]), at([LAMP_POSTS[1][0], -66, z])]), { tone: "lo" }));
  }
  out.push(S(k.slabOf(LAMP_BOX, LAMP_Z, LAMP_H, P, 8, 1.2), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(LAMP_BOX, 3), LAMP_Z + LAMP_H, P), { tone: "lo" }));
  out.push(D(k.corners(LAMP_BOX, 5).map(([x, y]) => at([x, y, LAMP_Z + LAMP_H])), { size: 0.45 }));
  // closed vent slots on the housing's near face, and the cable clamp beside them
  for (let index = 0; index < 5; index += 1) {
    const x0 = LAMP_BOX.x + 12 + index * 12;
    out.push(flatPiece(k.pathOf([at([x0, LAMP_BOX.y + LAMP_BOX.d + 0.4, LAMP_Z + 5]), at([x0 + 7, LAMP_BOX.y + LAMP_BOX.d + 0.4, LAMP_Z + 5]), at([x0 + 7, LAMP_BOX.y + LAMP_BOX.d + 0.4, LAMP_Z + 15]), at([x0, LAMP_BOX.y + LAMP_BOX.d + 0.4, LAMP_Z + 15])]), { tone: "lo" }));
  }
  out.push(S(k.slabOf({ x: LAMP_BOX.x + 6, y: LAMP_BOX.y + LAMP_BOX.d + 2, w: 10, d: 6, r: 1 }, LAMP_Z + 1, 5, P, 3, 0.4), { tone: "lo" }));
  const bulb = [-70, -65];
  out.push(S(k.cylinder(bulb[0], bulb[1], 11, LAMP_Z - 4, 5, P, 30), { tone: "lo" }));
  out.push(S(k.cylinder(bulb[0], bulb[1], 9, LAMP_Z - 13, 11, P, 30), { tone: "hi", lit: true }));
  out.push(D([at([bulb[0], bulb[1], LAMP_Z - 13])], { size: 0.4 }));
  return out.join("");
}

/** Five stencil plates on one bar: the conditional fragments, one in the beam. */
function stencils() {
  const out = [];
  out.push(S(k.slabOf({ x: STENCIL_X0 - 10, y: -70, w: STENCIL_PITCH * 5 + 12, d: 8, r: 2 }, STENCIL_BAR_Z, 5, P, 3, 0.5), { tone: "mid" }));
  for (let index = 0; index < 5; index += 1) {
    const x = STENCIL_X0 + index * STENCIL_PITCH;
    const live = index === STENCIL_LIVE;
    // the live plate hangs straight in the beam; the others are swung aside
    const swing = live ? 0 : index % 2 === 0 ? 1 : -1;
    const y = -66 + swing * 14;
    out.push(S(panel({ x0: x, x1: x + STENCIL_W, z0: STENCIL_BAR_Z - STENCIL_H, z1: STENCIL_BAR_Z - 3 }, y, 1.2), { tone: live ? "hi" : "mid", lit: live }));
    // the window in each plate: the fragment it lets through
    const win = { x0: x + 3.5, x1: x + STENCIL_W - 3.5, z0: STENCIL_BAR_Z - STENCIL_H + 7, z1: STENCIL_BAR_Z - 12 };
    out.push(flatPiece(k.pathOf([at([win.x0, y - 1.6, win.z0]), at([win.x1, y - 1.6, win.z0]), at([win.x1, y - 1.6, win.z1]), at([win.x0, y - 1.6, win.z1])]), { tone: live ? "hi" : "lo", lit: live }));
    // the hinge pin and its bracket: the plate hangs from the bar, it does not float
    out.push(L(k.ring(x + STENCIL_W / 2, y - 2, 2, STENCIL_BAR_Z - 5, P, 14), { tone: "mid" }));
    out.push(S(k.cylinder(x + STENCIL_W / 2, y - 2, 1.4, STENCIL_BAR_Z - 5, 9, P, 12), { tone: "mid" }));
    out.push(L(k.pathOf([at([x + STENCIL_W / 2, y, STENCIL_BAR_Z - 5]), at([x + STENCIL_W / 2, y, STENCIL_BAR_Z + 2])]), { tone: "lo" }));
  }
  // the selector's detent spring, under the bar
  out.push(S(k.slabOf({ x: STENCIL_X0 + STENCIL_PITCH * STENCIL_LIVE - 4, y: -78, w: 22, d: 6, r: 1 }, STENCIL_BAR_Z - 10, 4, P, 3, 0.4), { tone: "lo" }));
  return out.join("");
}

/** The beam: two edges from the reflector down to the stencil bar. Past the bar
 *  the light is on the sheet, and drawing it across the machine would read as
 *  stray diagonals rather than as light. */
function beam() {
  const bulb = [-70, -65];
  const out = [];
  for (const [index, dx] of [[0, -12], [1, 12]].entries()) {
    out.push(L(k.pathOf([
      at([bulb[0] + dx, bulb[1] - 8, LAMP_Z - 16]),
      at([bulb[0] + dx * 1.6, bulb[1] - 12, STENCIL_BAR_Z - 6]),
    ]), { tone: index === 0 ? "lo" : "faint", free: true }));
  }
  return out.join("");
}

// ------------------------------------------------------------------ the table
function lightTable() {
  const out = [];
  const legs = k.corners(TABLE, 12);
  for (const [x, y] of backToFront(legs)) {
    out.push(S(k.slabOf({ x: x - 4.5, y: y - 4.5, w: 9, d: 9, r: 1.5 }, TABLE_Z - 24, TABLE_Z - 24 + 24, P, 3, 0.4), { tone: "mid" }));
    out.push(D([at([x, y, 0])], { size: 0.4 }));
  }
  out.push(S(k.slabOf(TABLE, TABLE_Z, TABLE_H, P, 8, 1.2), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(TABLE, 4), TABLE_Z + TABLE_H, P), { tone: "lo" }));
  out.push(D(k.corners(TABLE, 7).map(([x, y]) => at([x, y, TABLE_Z + TABLE_H])), { size: 0.45 }));
  // the sheet: the one lit thing, because it is what the session is making
  out.push(S(k.slabOf(SHEET, TABLE_Z + TABLE_H, 1.6, P, 4, 0.5), { tone: "hi", lit: true }));
  for (const [index, width] of [110, 84, 56].entries()) {
    const y = SHEET.y + 16 + index * 16;
    out.push(L(k.lineOnTop([SHEET.x + 14, y], [SHEET.x + 14 + width, y], TABLE_Z + TABLE_H + 1.6, P), { tone: "faint", free: true }));
  }
  // the clip that holds it down
  const clip = { x: SHEET.x + 10, y: SHEET.y + 4, w: 26, d: 12, r: 2 };
  out.push(S(k.slabOf(clip, TABLE_Z + TABLE_H + 1.6, 5, P, 3, 0.6), { tone: "mid" }));
  out.push(D([at([clip.x + clip.w / 2, clip.y + clip.d / 2, TABLE_Z + TABLE_H + 6.6])], { size: 0.45 }));
  return out.join("");
}

// ---------------------------------------------------------------- the camera
function camera() {
  const out = [];
  for (const rail of RAILS) {
    out.push(S(k.slabOf(rail, 0, 7, P, 4, 0.6), { tone: "mid" }));
    out.push(L(k.planOutline(rail, 7, P), { tone: "lo" }));
    for (const y of [rail.y + 6, rail.y + rail.d - 6]) {
      out.push(D([at([rail.x + rail.w / 2, y, 7])], { size: 0.4 }));
    }
    // end stops, so the carriage cannot roll off
    for (const y of [rail.y - 6, rail.y + rail.d + 1]) {
      out.push(S(k.slabOf({ x: rail.x - 1, y, w: rail.w + 2, d: 5, r: 1 }, 0, 12, P, 3, 0.4), { tone: "mid" }));
    }
  }
  out.push(S(k.slabOf(CARRIAGE, CARRIAGE_Z, CARRIAGE_H, P, 6, 1), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(CARRIAGE, 3), CARRIAGE_Z + CARRIAGE_H, P), { tone: "lo" }));
  out.push(D(k.corners(CARRIAGE, 5).map(([x, y]) => at([x, y, CARRIAGE_Z + CARRIAGE_H])), { size: 0.42 }));
  // the lens is ground into the face that points at the sheet
  const face = CARRIAGE.x + 2;
  const centre = [face, CARRIAGE.y + CARRIAGE.d / 2, CARRIAGE_Z + CARRIAGE_H / 2];
  out.push(L(k.sideRing(centre, 13, "x", P, 34), { tone: "mid" }));
  out.push(L(k.sideRing(centre, 9.5, "x", P, 30), { tone: "lo" }));
  out.push(L(k.sideRing(centre, 5.6, "x", P, 26), { tone: "mid" }));
  out.push(S(k.cylinder(centre[1], centre[0], 5, centre[2], 0.4, P, 22), { tone: "hi", lit: true }));
  // the shutter release, on the near face
  out.push(S(k.cylinder(CARRIAGE.x + CARRIAGE.w / 2, CARRIAGE.y + CARRIAGE.d + 4, 4.2, CARRIAGE_Z + 10, 5, P, 20), { tone: "lo" }));
  out.push(L(k.ring(CARRIAGE.x + CARRIAGE.w / 2, CARRIAGE.y + CARRIAGE.d + 4, 4.2, CARRIAGE_Z + 15, P, 20), { tone: "lo" }));
  out.push(D([at([CARRIAGE.x + CARRIAGE.w / 2, CARRIAGE.y + CARRIAGE.d + 4, CARRIAGE_Z + 15])], { size: 0.4 }));
  // a focus collar on the far side
  out.push(S(k.cylinder(CARRIAGE.x + CARRIAGE.w / 2, CARRIAGE.y - 4, 3.6, CARRIAGE_Z + 12, 6, P, 18), { tone: "lo" }));
  return out.join("");
}

// ---------------------------------------------------------------- drying line
function dryingLine() {
  const out = [];
  for (const [x, y] of backToFront(LINE_POSTS)) {
    out.push(S(k.slabOf({ x: x - 5, y: y - 5, w: 10, d: 10, r: 1.5 }, 0, LINE_Z, P, 4, 0.5), { tone: "mid" }));
    out.push(D([at([x, y, LINE_Z])], { size: 0.45 }));
  }
  out.push(L(k.pathOf([at([LINE_POSTS[0][0], LINE_POSTS[0][1], LINE_Z - 6]), at([LINE_POSTS[1][0], LINE_POSTS[1][1], LINE_Z - 12])]), { tone: "mid" }));
  for (const [index, print] of PRINTS.entries()) {
    const x = print.x;
    const y = -92;
    const tone = index === 0 ? "hi" : "mid";
    out.push(L(k.pathOf([at([x + print.w / 2, y, LINE_Z - 8 - index * 3]), at([x + print.w / 2, y, print.z + print.h])]), { tone: "lo" }));
    out.push(S(k.slabOf({ x: x + print.w / 2 - 5, y: y - 3, w: 10, d: 6, r: 1 }, print.z + print.h - 4, 5, P, 3, 0.4), { tone: "mid" }));
    out.push(S(panel({ x0: x, x1: x + print.w, z0: print.z, z1: print.z + print.h }, y, 1), { tone }));
    for (const [line, width] of [0.72, 0.5, 0.3].entries()) {
      const z = print.z + print.h * line;
      out.push(L(k.pathOf([at([x + 3, y - 1.8, z]), at([x + 3 + (print.w - 6) * width, y - 1.8, z])]), { tone: "lo", free: true }));
    }
  }
  return out.join("");
}

// --------------------------------------------------------- keypad and the tape
function keypad() {
  const out = [];
  out.push(S(k.slabOf(KEYPAD, KEYPAD_Z - 26, 6, P, 4, 0.5), { tone: "lo" }));
  out.push(S(k.slabOf({ x: KEYPAD.x + 4, y: KEYPAD.y + 4, w: 6, d: 6, r: 1 }, KEYPAD_Z - 26, 26, P, 3, 0.4), { tone: "mid" }));
  out.push(S(k.slabOf({ x: KEYPAD.x + KEYPAD.w - 10, y: KEYPAD.y + KEYPAD.d - 10, w: 6, d: 6, r: 1 }, KEYPAD_Z - 26, 26, P, 3, 0.4), { tone: "mid" }));
  out.push(S(k.slabOf(KEYPAD, KEYPAD_Z - 9, KEYPAD_H, P, 5, 1), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(KEYPAD, 3), KEYPAD_Z, P), { tone: "lo" }));
  for (const [dx, dy] of [[16, 10], [34, 10], [16, 22], [34, 22]]) {
    const x = KEYPAD.x + dx;
    const y = KEYPAD.y + dy;
    out.push(S(k.cylinder(x, y, 4.2, KEYPAD_Z, 3, P, 20), { tone: "hi" }));
    out.push(L(k.ring(x, y, 4.2, KEYPAD_Z + 3, P, 20), { tone: "lo" }));
  }
  out.push(D([at([KEYPAD.x + KEYPAD.w - 12, KEYPAD.y + 10, KEYPAD_Z])], { size: 0.45 }));

  // the tape spool beside it, and the run that carries a decision back to the roll
  out.push(S(k.slabOf({ x: TAPE_SPOOL[0] - 10, y: TAPE_SPOOL[1] - 6, w: 20, d: 12, r: 2 }, 0, KEYPAD_Z - 20, P, 4, 0.5), { tone: "mid" }));
  out.push(S(k.cylinder(TAPE_SPOOL[0], TAPE_SPOOL[1], 11, KEYPAD_Z - 20, 14, P, 30), { tone: "hi" }));
  out.push(S(k.cylinder(TAPE_SPOOL[0], TAPE_SPOOL[1], 12.5, KEYPAD_Z - 18, 2, P, 30), { tone: "lo" }));
  out.push(S(k.cylinder(TAPE_SPOOL[0], TAPE_SPOOL[1], 12.5, KEYPAD_Z - 8, 2, P, 30), { tone: "lo" }));
  out.push(D([at([TAPE_SPOOL[0], TAPE_SPOOL[1], KEYPAD_Z - 6])], { size: 0.45 }));

  const route = [
    at([TAPE_SPOOL[0] - 4, TAPE_SPOOL[1] + 10, KEYPAD_Z - 16]),
    at([-96, 34, 12]),
    at([-118, 6, 6]),
    at([-140, -14, 8]),
    at([-150, -22, ROLL_Z - ROLL_H / 2 + 2]),
  ];
  out.push(L(k.pathOf(route), { tone: "mid" }));
  const punches = [];
  for (let t = 0.08; t <= 0.95; t += 0.055) {
    const segment = Math.min(Math.floor(t * (route.length - 1)), route.length - 2);
    const local = t * (route.length - 1) - segment;
    const [ax, ay] = [route[segment][0], route[segment][1]];
    const [bx, by] = [route[segment + 1][0], route[segment + 1][1]];
    punches.push([ax + (bx - ax) * local, ay + (by - ay) * local]);
  }
  out.push(D(punches, { size: 0.5, tone: "mid" }));
  return out.join("");
}

// ------------------------------------------------------------------- the gauge
function gauge() {
  const out = [];
  const [gx, gy] = GAUGE_POST;
  out.push(S(k.slabOf({ x: gx - 8, y: gy - 8, w: 16, d: 16, r: 2 }, 0, GAUGE_Z - 8, P, 4, 0.6), { tone: "mid" }));
  out.push(S(k.cylinder(gx, gy, 5, GAUGE_Z - 8, 8, P, 20), { tone: "mid" }));
  out.push(S(k.cylinder(gx, gy, 6.4, GAUGE_Z - 30, 4, P, 22), { tone: "lo" }));
  out.push(S(k.cylinder(gx, gy, 4.4, GAUGE_Z - 56, 4, P, 20), { tone: "lo" }));
  out.push(D([at([gx, gy, GAUGE_Z])], { size: 0.45 }));
  // a scale up the pedestal, so the column is not a bare face
  const stem = k.topTicks(gy - 6, gy + 6, 3, 3, gx + 5.6, GAUGE_Z - 52, [1.6, 3], P, "y");
  out.push(L(stem.minor, { tone: "lo" }), L(stem.major, { tone: "mid" }));
  // the bracket the dial sits on
  out.push(S(k.slabOf({ x: gx - GAUGE_R - 6, y: gy - 5, w: (GAUGE_R + 6) * 2, d: 10, r: 2 }, GAUGE_Z, 4, P, 3, 0.4), { tone: "mid" }));
  // the dial: a puck with a bezel, a tick ring, a needle and a hub
  out.push(S(k.cylinder(gx, gy, GAUGE_R, GAUGE_Z + 4, GAUGE_H, P, 28), { tone: "hi" }));
  out.push(S(k.cylinder(gx, gy, GAUGE_R + 2, GAUGE_Z + 4, 2.4, P, 28), { tone: "lo" }));
  out.push(S(k.cylinder(gx, gy, GAUGE_R + 2, GAUGE_Z + 4 + GAUGE_H - 2.4, 2.4, P, 28), { tone: "lo" }));
  out.push(L(k.ring(gx, gy, GAUGE_R, GAUGE_Z + 4 + GAUGE_H, P, 28), { tone: "lo" }));
  const ticks = k.radialTicks(gx, gy, GAUGE_R - 4, 32, 5, GAUGE_Z + 4 + GAUGE_H, [2.4, 4.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  const zeroAngle = Math.PI * 0.7;
  const zero = [gx + Math.cos(zeroAngle) * (GAUGE_R - 9), gy + Math.sin(zeroAngle) * (GAUGE_R - 9)];
  out.push(D([at([zero[0], zero[1], GAUGE_Z + 4 + GAUGE_H])], { size: 0.5, tone: "hi" }));
  // the needle reads the check's coverage: most of the dial, not all of it
  const needleAngle = -Math.PI * 0.22;
  const tip = [gx + Math.cos(needleAngle) * (GAUGE_R - 7), gy + Math.sin(needleAngle) * (GAUGE_R - 7)];
  out.push(L(k.lineOnTop([gx, gy], tip, GAUGE_Z + 4 + GAUGE_H + 0.2, P), { tone: "hi" }));
  out.push(S(k.cylinder(gx, gy, 3, GAUGE_Z + 4 + GAUGE_H, 2.2, P, 18), { tone: "mid" }));
  // its own run to the base
  out.push(D([at([gx - GAUGE_R, gy, GAUGE_Z + 2])], { size: 0.4 }));
  return out.join("");
}

// ------------------------------------------------------------------- assembly
function figure() {
  const layers = backToFront([
    [-70, -95, () => lamp()],
    [-70, -80, () => beam()],
    [-70, -70, () => stencils()],
    [40, -74, () => lensRack()],
    [90, -92, () => dryingLine()],
    [126, 14, () => gauge()],
    [-146, -12, () => paperRoll()],
    [4, -20, () => lightTable()],
    [124, -18, () => camera()],
    [-100, 60, () => keypad()],
  ]);
  return layers.map(([, , build]) => build()).join("");
}

const body = base() + figure();

// cables: each device's own run to the base, drawn last so nothing crosses a face
const wires = [
  k.wireSvg(at([-104, -66, 24]), at([-150, -52, 1]), { via: [at([-118, -60, 14]), at([-140, -56, 4])], ends: "both", size: 1.1 }),
  k.wireSvg(at([CARRIAGE.x + CARRIAGE.w / 2, CARRIAGE.y + CARRIAGE.d + 5, CARRIAGE_Z]), at([150, 40, 1]), { via: [at([146, 10, 34]), at([150, 26, 12])], ends: "both", size: 1.1 }),
  k.wireSvg(at([GAUGE_POST[0] + 8, GAUGE_POST[1], 6]), at([150, 60, 1]), { via: [at([140, 34, 4]), at([146, 50, 2])], ends: "both", size: 1.1 }),
].join("");

/** The kit's dark ramp is tuned for an app canvas; a README plate needs the steps
 *  to read at 800 px wide. Same palette, lifted — and the light plate gets a
 *  slightly deeper face so its faces separate on paper. */
const PLATE_CSS = `
.iso[data-theme="dark"]{
  --anatomy-weight:.9px;
  --anatomy-paper:#191a1f; --anatomy-face:#24262c; --anatomy-top:#3d404a;
  --anatomy-shade-0:#17181c; --anatomy-shade-1:#1e1f25; --anatomy-shade-2:#282a31; --anatomy-shade-3:#32343c;
  --anatomy-lit-top:#4c505c; --anatomy-lit-shade:#3f424c;
  --anatomy-hi:#f4f4f8; --anatomy-mid:#a2a3ad; --anatomy-lo:#5c5d68; --anatomy-faint:#3c3d46;
  --anatomy-halo:#08080b;
}
.iso[data-theme="light"]{
  --anatomy-weight:.9px;
  --anatomy-weight:1.05px;
  --anatomy-paper:#f7f7f3; --anatomy-face:#eeece6; --anatomy-top:#faf9f5;
  --anatomy-shade-0:#a8a9a2; --anatomy-shade-1:#bcbdb6; --anatomy-shade-2:#cecfc8; --anatomy-shade-3:#dedfd8;
  --anatomy-lit-top:#fdfcf8; --anatomy-lit-shade:#cfd0c9;
  --anatomy-hi:#141417; --anatomy-mid:#4c4c53; --anatomy-lo:#74747b; --anatomy-faint:#a9aab0;
  --anatomy-halo:#b9b9ae;
}`;
function themeSvg(kitSvg) {
  return kitSvg.replace("</style>", `${PLATE_CSS}</style>`);
}

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label: theme === "light"
    ? "omp-designer: the contract bench, light plate"
    : "omp-designer: the contract bench",
  standalone: theme,
  className: "iso",
  body: body + wires,
});

const out = join(ROOT, "docs", theme === "light" ? "architecture-light.svg" : "architecture.svg");
writeFileSync(out, `${themeSvg(svg)}\n`);
console.log(`wrote ${out} (${(svg.length / 1024).toFixed(1)} KB, theme ${theme})`);
console.log(svg.slice(0, 160).replace(/\n/g, " "));

if (process.argv.includes("--page")) {
  const pageDir = join(ROOT, "test-output");
  mkdirSync(pageDir, { recursive: true });
  const page = join(pageDir, `architecture-${theme}.html`);
  writeFileSync(page, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<title>architecture figure (${theme})</title>\n</head><body style="margin:0;background:${theme === "light" ? "#f4f4f5" : "#0b0b0c"}">\n${themeSvg(svg)}\n</body></html>\n`);
  console.log(`wrote ${page}`);
}
