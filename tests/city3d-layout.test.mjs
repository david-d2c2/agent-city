import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../web/city3d-layout.js";

const boxOf = (b) => ({
  x0: b.x - b.w / 2,
  x1: b.x + b.w / 2,
  z0: b.z - b.d / 2,
  z1: b.z + b.d / 2,
});
const inside = (b, x, z) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;

test("all six building types are placed", () => {
  assert.deepEqual(Object.keys(L.BUILDINGS).sort(), [...L.TYPES].sort());
  assert.equal(L.TYPES.length, 6);
});

test("footprints do not overlap and stay inside the ground", () => {
  const boxes = L.TYPES.map((t) => [t, boxOf(L.BUILDINGS[t])]);
  for (const [, b] of boxes) {
    assert.ok(b.x0 >= -L.GROUND.w / 2 && b.x1 <= L.GROUND.w / 2);
    assert.ok(b.z0 >= -L.GROUND.d / 2 && b.z1 <= L.GROUND.d / 2);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i][1];
      const b = boxes[j][1];
      const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0;
      assert.ok(apart, `${boxes[i][0]} overlaps ${boxes[j][0]}`);
    }
});

test("typeForSpace uses space.type and falls back to index order", () => {
  assert.equal(L.typeForSpace({ type: "studio" }, 0), "studio");
  assert.equal(L.typeForSpace({ type: "nope" }, 2), "library");
  assert.equal(L.typeForSpace({}, 4), "studio");
  assert.equal(L.typeForSpace(undefined, 7), "home");
});

test("assignTypes gives each space a distinct building and drops overflow", () => {
  const spaces = [{ type: "home" }, { type: "home" }, {}, {}, {}, {}, {}];
  const types = L.assignTypes(spaces);
  const used = types.filter(Boolean);
  assert.equal(new Set(used).size, used.length);
  assert.equal(used.length, 6);
  assert.equal(types[6], null);
});

test("robotSlots: 3 distinct deterministic positions outside the footprint", () => {
  for (const t of L.TYPES) {
    const slots = L.robotSlots(t);
    assert.equal(slots.length, 3);
    assert.equal(new Set(slots.map((s) => `${s.x},${s.z}`)).size, 3);
    const b = boxOf(L.BUILDINGS[t]);
    for (const s of slots) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
      assert.ok(!inside(b, s.x, s.z));
      for (const other of L.TYPES) assert.ok(!inside(boxOf(L.BUILDINGS[other]), s.x, s.z));
    }
    assert.deepEqual(slots, L.robotSlots(t));
  }
});

test("streetPath returns two finite waypoints clear of every footprint", () => {
  for (const t of L.TYPES) {
    const path = L.streetPath(t);
    assert.equal(path.length, 2);
    for (const p of path) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
      for (const other of L.TYPES) assert.ok(!inside(boxOf(L.BUILDINGS[other]), p.x, p.z));
    }
  }
});

test("lamps are inside the ground and not inside a building", () => {
  assert.ok(L.LAMPS.length >= 12);
  for (const l of L.LAMPS) {
    assert.ok(Math.abs(l.x) < L.GROUND.w / 2 && Math.abs(l.z) < L.GROUND.d / 2);
    for (const t of L.TYPES) assert.ok(!inside(boxOf(L.BUILDINGS[t]), l.x, l.z));
  }
});

test("roads stay inside the ground and layout is deterministic", () => {
  for (const r of L.ROAD_SEGMENTS) {
    assert.ok(Math.abs(r.x) + r.w / 2 <= L.GROUND.w / 2);
    assert.ok(Math.abs(r.z) + r.d / 2 <= L.GROUND.d / 2);
  }
  assert.deepEqual(structuredClone(L.BUILDINGS), structuredClone(L.BUILDINGS));
  assert.deepEqual(L.robotSlots("home"), L.robotSlots("home"));
});

test("cameraRig yields a finite frustum and clamps zoom", () => {
  for (const a of [0.5, 1, 1.78, NaN]) {
    const r = L.cameraRig(a, 1);
    for (const v of [r.left, r.right, r.top, r.bottom, r.near, r.far, ...Object.values(r.position)])
      assert.ok(Number.isFinite(v));
  }
  assert.equal(L.cameraRig(1, 99).top, L.cameraRig(1, 2).top);
});
