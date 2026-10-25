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

// ---------------------------------------------------------------- scale: heights, districts, ground, camera fit
const SPACES = [
  { id: "office", type: "office", kind: "context", name: "Oficina" },
  { id: "home", type: "home", kind: "context", name: "Casa" },
  { id: "library", type: "library", kind: "specialty", name: "Biblioteca" },
  { id: "workshop", type: "workshop", kind: "specialty", name: "Taller" },
  { id: "studio", type: "studio", kind: "specialty", name: "Estudio" },
  { id: "control", type: "control", kind: "specialty", name: "Torre" },
];
const mkProjects = (spaceId, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `${spaceId}-${i}`, name: `Proyecto ${i}`, spaceIds: [spaceId] }));
const lotBox = (l) => ({ x0: l.x - l.w / 2, x1: l.x + l.w / 2, z0: l.z - l.d / 2, z1: l.z + l.d / 2 });
const overlaps = (a, b) => !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0);

test("heightFactor is monotonic, saturating and bounded", () => {
  assert.equal(L.heightFactor(0), 0);
  assert.equal(L.heightFactor(-5), 0);
  assert.equal(L.heightFactor("x"), 0);
  assert.equal(L.heightFactor(L.GROWTH_K), 0.5);
  let last = -1;
  for (let n = 0; n <= 500; n++) {
    const t = L.heightFactor(n);
    assert.ok(t > last && t < 1, `strictly increasing and below 1 at ${n}`);
    last = t;
  }
  assert.ok(L.heightFactor(41) > L.heightFactor(1) * 5);
});

test("buildingHeight stays inside each type range and 41 agents read clearly taller than 1", () => {
  for (const t of L.TYPES) {
    const [lo, hi] = L.HEIGHT_RANGE[t];
    assert.ok(lo < hi);
    assert.equal(L.buildingHeight(t, 0), lo);
    for (const n of [0, 1, 5, 41, 145, 10000]) {
      const h = L.buildingHeight(t, n);
      assert.ok(h >= lo && h < hi, `${t} ${n}`);
    }
    for (let n = 0; n < 200; n++) assert.ok(L.buildingHeight(t, n + 1) > L.buildingHeight(t, n));
    const spread = (L.buildingHeight(t, 41) - lo) / (L.buildingHeight(t, 1) - lo);
    assert.ok(spread > 5, `${t}: 41 agents must read clearly taller than 1`);
    assert.ok(L.buildingHeight(t, 1) < (lo + hi) / 2 && L.buildingHeight(t, 41) > (lo + hi) / 2);
  }
  assert.equal(L.buildingHeight("nope", 3), L.buildingHeight("office", 3));
});

test("cityPlan: core buildings keep their footprint and take their height from the agents of their space", () => {
  const plan = L.cityPlan({ spaces: SPACES, agentCountBySpace: { office: 41, home: 1, library: 3 } });
  assert.equal(plan.buildings.length, 6);
  for (const b of plan.buildings) {
    const spec = L.BUILDINGS[b.type];
    assert.deepEqual([b.x, b.z, b.w, b.d, b.yaw], [spec.x, spec.z, spec.w, spec.d, spec.yaw]);
    assert.equal(b.h, L.buildingHeight(b.type, b.agents));
    assert.equal(b.grow, L.heightFactor(b.agents));
  }
  const by = Object.fromEntries(plan.buildings.map((b) => [b.spaceId, b]));
  assert.ok(by.office.h > by.library.h && by.library.h > by.home.h);
  assert.equal(by.studio.agents, 0);
  assert.equal(by.studio.h, L.HEIGHT_RANGE.studio[0]);
});

test("cityPlan without projects is the original city: same ground, no extra roads, original camera fit", () => {
  const plan = L.cityPlan({ spaces: SPACES });
  assert.deepEqual(plan.ground, { w: L.GROUND.w, d: L.GROUND.d, cx: 0, cz: 0 });
  assert.deepEqual(plan.districts, []);
  assert.deepEqual(plan.roads, []);
  assert.deepEqual(plan.lamps, []);
  assert.deepEqual(plan.camera.target, { x: 0, z: 0 });
  assert.equal(plan.camera.fitW, 66);
  assert.equal(plan.camera.fitH, 47);
  assert.equal(plan.camera.panLimit, 26);
  assert.deepEqual(plan.bounds, { minX: -24, maxX: 24, minZ: -17, maxZ: 17 });
  const empty = L.cityPlan();
  assert.deepEqual(empty.buildings, []);
  assert.equal(empty.camera.fitW, 66);
  // context spaces with an empty project list do not grow the ground either
  assert.deepEqual(L.cityPlan({ spaces: SPACES, projectsBySpace: { office: [], home: [] } }).ground, plan.ground);
});

test("cityPlan: only context spaces get a district, in space order", () => {
  const projects = [...mkProjects("office", 2), ...mkProjects("home", 3), ...mkProjects("library", 4), ...mkProjects("studio", 1)];
  const plan = L.cityPlan({ spaces: SPACES, projects });
  assert.deepEqual(
    plan.districts.map((d) => [d.spaceId, d.lots.length, d.total, d.overflow]),
    [
      ["office", 2, 2, 0],
      ["home", 3, 3, 0],
    ],
  );
  assert.equal(plan.districts[0].name, "Oficina");
  assert.ok(plan.districts[0].x0 < plan.districts[1].x0);
});

test("cityPlan: projectsBySpace wins over spaceIds and duplicates are drawn once per district", () => {
  const a = { id: "a", name: "A", spaceIds: [] };
  const plan = L.cityPlan({ spaces: SPACES, projects: [], projectsBySpace: { office: [a, a, null, { name: "no id" }] } });
  assert.equal(plan.districts.length, 1);
  assert.deepEqual(plan.districts[0].lots.map((l) => l.projectId), ["a"]);
  const both = { id: "x", name: "X", spaceIds: ["office", "home"] };
  const shared = L.cityPlan({ spaces: SPACES, projects: [both] });
  assert.deepEqual(shared.districts.map((d) => d.lots[0].projectId), ["x", "x"]);
});

test("district grid: lots on distinct cells, no overlaps, inside their pad and the ground, deterministic", () => {
  const projects = [...mkProjects("office", 16), ...mkProjects("home", 43)];
  const counts = Object.fromEntries(projects.map((p, i) => [p.id, (i * 7) % 11]));
  const input = { spaces: SPACES, projects, agentCountByProject: counts, agentCountBySpace: { office: 20 } };
  const plan = L.cityPlan(input);
  assert.deepEqual(L.cityPlan(input), plan);
  const all = [];
  for (const d of plan.districts) {
    assert.ok(d.cols * d.rows >= d.lots.length && d.cols * (d.rows - 1) < d.lots.length);
    assert.ok(d.cols > d.rows, "strip is wider than tall");
    const cells = new Set(d.lots.map((l) => `${l.row},${l.col}`));
    assert.equal(cells.size, d.lots.length);
    for (const l of d.lots) {
      const b = lotBox(l);
      assert.ok(b.x0 >= d.x0 && b.x1 <= d.x0 + d.w && b.z0 >= d.z0 && b.z1 <= d.z0 + d.d, "lot inside its pad");
      assert.ok(b.x0 >= plan.bounds.minX && b.x1 <= plan.bounds.maxX && b.z0 >= plan.bounds.minZ && b.z1 <= plan.bounds.maxZ);
      assert.ok(b.z0 > L.GROUND.d / 2, "lots start beyond the core ground");
      all.push(b);
    }
    assert.ok(d.sign.z >= d.z0 + d.d - 1e-9 && d.more.x >= d.sign.x);
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]));
  const [a, b] = plan.districts;
  assert.ok(a.x0 + a.w <= b.x0, "districts do not overlap");
});

test("lots are ordered by agents (most first), then name, then id; taller lots are never in front", () => {
  const projects = [
    { id: "b", name: "Beta", spaceIds: ["office"] },
    { id: "a", name: "Alfa", spaceIds: ["office"] },
    { id: "c", name: "Alfa", spaceIds: ["office"] },
    { id: "z", name: "Zeta", spaceIds: ["office"] },
  ];
  const plan = L.cityPlan({ spaces: SPACES, projects, agentCountByProject: { z: 9, b: 2 } });
  assert.deepEqual(plan.districts[0].lots.map((l) => l.projectId), ["z", "b", "a", "c"]);
  const lots = plan.districts[0].lots;
  for (let i = 1; i < lots.length; i++) assert.ok(lots[i].h <= lots[i - 1].h);
});

test("lotHeight: zero agents is a low slab, then storeys grow monotonically and cap at six", () => {
  assert.equal(L.lotFloors(0), 0);
  assert.equal(L.lotHeight(0), L.LOT.plinth);
  assert.deepEqual([1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 1000].map(L.lotFloors), [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  let last = -1;
  for (let n = 0; n < 300; n++) {
    const h = L.lotHeight(n);
    assert.ok(h >= last);
    last = h;
  }
  assert.ok(L.lotHeight(0) > 0 && L.lotHeight(1) > L.lotHeight(0));
  assert.equal(L.lotHeight(10000), L.LOT.plinth + L.LOT.floorH * L.LOT.maxFloors);
  assert.ok(L.lotHeight(10000) < 8);
});

test("overflow: drawn lots are capped per district and the rest is counted", () => {
  const plan = L.cityPlan({ spaces: SPACES, projects: mkProjects("home", 400) });
  const d = plan.districts[0];
  assert.equal(d.lots.length, L.LOT.cap);
  assert.equal(d.total, 400);
  assert.equal(d.overflow, 340);
  const small = L.cityPlan({ spaces: SPACES, projects: mkProjects("home", 10), caps: { lotsPerDistrict: 4 } });
  assert.equal(small.districts[0].lots.length, 4);
  assert.equal(small.districts[0].overflow, 6);
  // the dropped ones are the ones with the fewest agents
  const kept = L.cityPlan({
    spaces: SPACES,
    projects: mkProjects("home", 10),
    agentCountByProject: { "home-9": 5 },
    caps: { lotsPerDistrict: 1 },
  });
  assert.equal(kept.districts[0].lots[0].projectId, "home-9");
});

test("bounds, ground and camera fit grow with the number of projects and keep the ground in view", () => {
  const at = (n) => {
    const office = Math.round(n / 4);
    return L.cityPlan({ spaces: SPACES, projects: [...mkProjects("office", office), ...mkProjects("home", n - office)] });
  };
  const plans = [0, 1, 4, 16, 59, 120].map(at);
  for (let i = 1; i < plans.length; i++) {
    const prev = plans[i - 1];
    const cur = plans[i];
    assert.ok(cur.ground.w * cur.ground.d >= prev.ground.w * prev.ground.d - 1e-9);
    assert.ok(cur.camera.fitW >= prev.camera.fitW - 1e-9);
    assert.ok(cur.camera.panLimit >= prev.camera.panLimit);
  }
  assert.ok(plans[4].ground.d > L.GROUND.d && plans[4].camera.fitW > 66 && plans[4].camera.fitH > 47);
  for (const plan of plans) {
    const t = plan.camera.target;
    const rig = L.cameraRig(66 / 47, 1, { x: t.x, y: 4, z: t.z }, { w: plan.camera.fitW, h: plan.camera.fitH });
    const { cx, cz, w, d } = plan.ground;
    for (const x of [cx - w / 2, cx + w / 2])
      for (const z of [cz - d / 2, cz + d / 2]) {
        const sx = (x - t.x - (z - t.z)) / Math.SQRT2;
        const sy = (-(x - t.x) - 8 - (z - t.z)) / Math.sqrt(6);
        assert.ok(sx > rig.left && sx < rig.right, "ground inside horizontally");
        assert.ok(sy > rig.bottom && sy < rig.top, "ground inside vertically");
      }
  }
});

test("tall buildings never leave the frame: the fit grows only when a roof would fall outside", () => {
  const low = L.cityPlan({ spaces: SPACES, agentCountBySpace: { office: 1, control: 1 } });
  assert.equal(low.camera.fitH, 47);
  const tall = L.cityPlan({ spaces: SPACES, agentCountBySpace: { office: 9999, control: 9999 } });
  assert.ok(tall.camera.fitH > 47);
  const mid = L.cityPlan({ spaces: SPACES, agentCountBySpace: { office: 100, control: 100 } });
  assert.ok(mid.camera.fitH >= low.camera.fitH && mid.camera.fitH <= tall.camera.fitH);
});

test("extra roads and lamps stay inside the grown ground and clear of the lots", () => {
  const plan = L.cityPlan({ spaces: SPACES, projects: [...mkProjects("office", 16), ...mkProjects("home", 43)] });
  assert.ok(plan.roads.length >= 4);
  for (const r of plan.roads) {
    assert.ok(r.x - r.w / 2 >= plan.bounds.minX && r.x + r.w / 2 <= plan.bounds.maxX);
    assert.ok(r.z - r.d / 2 >= plan.bounds.minZ && r.z + r.d / 2 <= plan.bounds.maxZ);
  }
  assert.ok(plan.lamps.length >= 3);
  for (const l of plan.lamps) {
    assert.ok(l.x > plan.bounds.minX && l.x < plan.bounds.maxX && l.z > plan.bounds.minZ && l.z < plan.bounds.maxZ);
    const dot = { x0: l.x - 0.2, x1: l.x + 0.2, z0: l.z - 0.2, z1: l.z + 0.2 };
    for (const d of plan.districts) for (const lot of d.lots) assert.ok(!overlaps(dot, lotBox(lot)));
  }
});

test("cameraRig honours a custom fit and falls back to the original one", () => {
  const base = L.cameraRig(1.4, 1);
  assert.deepEqual(L.cameraRig(1.4, 1, undefined, L.BASE_FIT), base);
  const o = { x: 0, y: 4, z: 0 };
  assert.ok(L.cameraRig(1.4, 1, o, { w: 120, h: 80 }).top > L.cameraRig(1.4, 1, o).top);
  for (const bad of [null, {}, { w: NaN, h: -1 }]) assert.equal(L.cameraRig(1.4, 1, o, bad).top, L.cameraRig(1.4, 1, o).top);
});
