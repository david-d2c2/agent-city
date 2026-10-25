// Pure placement data for the 3D colony. No DOM, no THREE: unit tested in Node.
// World units on an XZ ground plane (y is up). The camera sees the +X and +Z faces,
// so every door is on the +X face and robots stand on the street running past it.

export const TYPES = ["office", "home", "library", "workshop", "studio", "control"];

export const GROUND = { w: 48, d: 34, h: 0.7 };

// h is the overall height including masts/antennas (used for label anchors and cameras).
export const BUILDINGS = {
  office: { x: -16, z: -8.5, w: 6, d: 6, h: 16, yaw: 0 },
  home: { x: 0, z: -8.5, w: 7, d: 7, h: 7.5, yaw: 0 },
  library: { x: 16, z: -8.5, w: 6, d: 6, h: 6.5, yaw: 0 },
  workshop: { x: -16, z: 9.5, w: 6, d: 8, h: 8, yaw: 0 },
  studio: { x: 0, z: 9.5, w: 7, d: 7, h: 9, yaw: 0 },
  control: { x: 16, z: 9.5, w: 5, d: 5, h: 15, yaw: 0 },
};

export const PLAZA = { x: 0, z: 0, r: 4 };

// Axis-aligned road rectangles centred on (x, z). The avenue runs along X, the
// three streets along Z pass right in front of each column of doors.
export const ROAD_SEGMENTS = [
  { x: 0, z: 0, w: 46, d: 2.6 },
  { x: -11.6, z: 0, w: 2.2, d: 26 },
  { x: 4.8, z: 0, w: 2.2, d: 26 },
  { x: 20.4, z: 0, w: 2.2, d: 26 },
];

// Lamp posts: x, z and which colour the tip uses (mint or amber). Static decor.
export const LAMPS = [
  { x: -21, z: -2.4, tone: "mint" },
  { x: -8, z: -2.4, tone: "amber" },
  { x: 9, z: -2.4, tone: "mint" },
  { x: -21, z: 2.4, tone: "amber" },
  { x: -8, z: 2.4, tone: "mint" },
  { x: 9, z: 2.4, tone: "amber" },
  { x: 22, z: 2.4, tone: "mint" },
  { x: -9.2, z: -9.5, tone: "mint" },
  { x: -9.2, z: 11, tone: "amber" },
  { x: 6.4, z: -11, tone: "amber" },
  { x: 6.4, z: 11.5, tone: "mint" },
  { x: 22.2, z: -9, tone: "amber" },
  { x: 22.2, z: 10, tone: "mint" },
];

const SLOT_OFFSET = 1.3;
const SLOT_SPREAD = 1.25;

export function typeForSpace(space, index = 0) {
  if (space && Object.hasOwn(BUILDINGS, space.type)) return space.type;
  return TYPES[((index % TYPES.length) + TYPES.length) % TYPES.length];
}

// One building per type: a duplicate type falls back to the first free one,
// and spaces beyond the six available plots get null (they are not drawn).
export function assignTypes(spaces) {
  const used = new Set();
  return (spaces ?? []).map((space, index) => {
    let type = typeForSpace(space, index);
    if (used.has(type)) type = TYPES.find((t) => !used.has(t)) ?? null;
    if (type) used.add(type);
    return type;
  });
}

// Three standing positions on the street beside the door (+X face).
export function robotSlots(type) {
  const b = BUILDINGS[type] ?? BUILDINGS.office;
  const x = b.x + b.w / 2 + SLOT_OFFSET;
  return [-1, 0, 1].map((k) => ({ x, z: b.z + k * SLOT_SPREAD }));
}

// Door and the point where the street meets the avenue; used by working robots.
export function streetPath(type) {
  const b = BUILDINGS[type] ?? BUILDINGS.office;
  const x = b.x + b.w / 2 + SLOT_OFFSET;
  const towardAvenue = b.z < 0 ? -2 : 2;
  return [
    { x, z: b.z },
    { x, z: towardAvenue },
  ];
}

// Orthographic rig at the classic isometric angle (35.264 deg elevation, 45 deg azimuth).
// `fit` is the visible world extent at scale 1 (see cityPlan().camera); the default is the original six-building city.
const ISO = 1 / Math.sqrt(3);
export const BASE_FIT = { w: 66, h: 47 };
export function cameraRig(aspect, scale = 1, target = { x: 0, y: 0, z: 0 }, fit = BASE_FIT) {
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(2, Math.max(0.65, scale)) : 1;
  const fitW = Number.isFinite(fit?.w) && fit.w > 0 ? fit.w : BASE_FIT.w;
  const fitH = Number.isFinite(fit?.h) && fit.h > 0 ? fit.h : BASE_FIT.h;
  const height = Math.max(fitW / a, fitH) / s;
  const halfH = height / 2;
  const halfW = halfH * a;
  const dist = 90;
  return {
    left: -halfW,
    right: halfW,
    top: halfH,
    bottom: -halfH,
    near: 1,
    far: dist * 2.4,
    position: {
      x: target.x + ISO * dist,
      y: target.y + ISO * dist,
      z: target.z + ISO * dist,
    },
  };
}

// ---------------------------------------------------------------- scale: heights, districts, ground, camera fit
const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

// Building height grows with UNIQUE agents through a saturating curve: t = n / (n + GROWTH_K), so 0 agents -> 0,
// 14 agents -> 0.5, 41 -> 0.75, 145 -> 0.91 and never above 1. Height is then lerped inside the per-type
// [lo, hi] range (world units, mast included), which is the absolute clamp. The 3D builders interpolate their own
// geometry with the same `grow` value, so a building's top equals buildingHeight() (checked in the browser).
export const GROWTH_K = 14;
export const HEIGHT_RANGE = {
  office: [9.73, 24.85],
  home: [4.88, 10.7],
  library: [5.12, 14.88],
  workshop: [7.5, 13.3],
  studio: [5.91, 10.91],
  control: [11.19, 23.19],
};
export const heightFactor = (agents) => {
  const n = count(agents);
  return n / (n + GROWTH_K);
};
export function buildingHeight(type, agents) {
  const [lo, hi] = HEIGHT_RANGE[type] ?? HEIGHT_RANGE.office;
  return lo + (hi - lo) * heightFactor(agents);
}

// Project lots. A lot is a small tower of `floors` storeys on a slab; zero agents leave only the slab.
// floors = ceil(log2(agents + 1)) capped at 6: 1 -> 1, 2-3 -> 2, 4-7 -> 3, 8-15 -> 4, 16-31 -> 5, 32+ -> 6.
export const LOT = { size: 2.3, pitch: 3.1, pad: 1.3, cap: 60, aspect: 1.5, maxFloors: 6, floorH: 1.1, plinth: 0.3 };
export const DISTRICT = { z0: 22.2, gap: 3.2, margin: 2.5 };
export const BOULEVARD = { z: 19, d: 2.2 };
export const lotFloors = (agents) => {
  const n = count(agents);
  return n === 0 ? 0 : Math.min(LOT.maxFloors, Math.ceil(Math.log2(n + 1)));
};
export const lotHeight = (agents) => LOT.plinth + LOT.floorH * lotFloors(agents);

// Grid of a district: wider than tall (it is a strip in front of the core), never more cells than lots.
export function districtGrid(n) {
  const lots = count(n);
  if (!lots) return { cols: 0, rows: 0 };
  const cols = Math.min(lots, Math.max(1, Math.ceil(Math.sqrt(lots * LOT.aspect))));
  return { cols, rows: Math.ceil(lots / cols) };
}

const SQRT2 = Math.SQRT2;
const SQRT6 = Math.sqrt(6);
const TARGET_Y = 4;
const FIT_MARGIN = { x: 4, y: 1.3 }; // per side, inside BASE_FIT
const BASE_PAN = 26;

// Fits the camera to the ground rectangle and to every roof: the visible extent never drops below the original
// 66 x 47 and the target only moves when something would fall outside it, so a city without projects keeps the
// original framing. Screen axes: sx = (x - z) / sqrt2 (right), sy = (-x + 2y - z) / sqrt6 (up).
function cameraFit(ground, solids) {
  const pts = [];
  const hw = ground.w / 2;
  const hd = ground.d / 2;
  for (const x of [ground.cx - hw, ground.cx + hw])
    for (const z of [ground.cz - hd, ground.cz + hd]) pts.push([x, 0, z]);
  for (const s of solids)
    for (const x of [s.x0, s.x1]) for (const z of [s.z0, s.z1]) pts.push([x, s.h, z]);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y, z] of pts) {
    const sx = (x - ground.cx - (z - ground.cz)) / SQRT2;
    const sy = (-(x - ground.cx) + 2 * (y - TARGET_Y) - (z - ground.cz)) / SQRT6;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  const halfW = BASE_FIT.w / 2 - FIT_MARGIN.x;
  const halfH = BASE_FIT.h / 2 - FIT_MARGIN.y;
  const over = (v) => Math.max(0, v);
  const right = over(maxX - halfW);
  const left = over(-minX - halfW);
  const top = over(maxY - halfH);
  const bottom = over(-minY - halfH);
  const shiftX = (right - left) / 2;
  const shiftY = (top - bottom) / 2;
  return {
    target: {
      x: ground.cx + (SQRT2 * shiftX - SQRT6 * shiftY) / 2,
      z: ground.cz + (-SQRT2 * shiftX - SQRT6 * shiftY) / 2,
    },
    fitW: BASE_FIT.w + right + left,
    fitH: BASE_FIT.h + top + bottom,
    panLimit: BASE_PAN + Math.max(0, ground.w - GROUND.w, ground.d - GROUND.d) / 2,
  };
}

// The whole static plan of the colony: core buildings (position fixed, height from agents), one district of lots per
// context space that has projects, the ground that holds them and the camera fit.
//   spaces: organization.spaces; projects: organization.projects (membership by spaceIds) or projectsBySpace
//   {spaceId: [project]} when the caller already resolved it; agentCountBySpace / agentCountByProject: {id: n}.
// Lots are ordered by agents (most first), then name, so the tallest sit at the back and never hide the rest.
export function cityPlan({
  spaces = [],
  projects = [],
  projectsBySpace,
  agentCountBySpace = {},
  agentCountByProject = {},
  caps = {},
} = {}) {
  const list = Array.isArray(spaces) ? spaces : [];
  const perDistrict = Math.max(1, Math.min(200, count(caps.lotsPerDistrict) || LOT.cap));
  const own = (map, id) => (map && Object.hasOwn(map, id) ? count(map[id]) : 0);
  const types = assignTypes(list);
  const buildings = [];
  list.forEach((space, i) => {
    const type = types[i];
    if (!type) return;
    const spec = BUILDINGS[type];
    const agents = own(agentCountBySpace, space.id);
    buildings.push({
      spaceId: space.id,
      type,
      x: spec.x,
      z: spec.z,
      w: spec.w,
      d: spec.d,
      yaw: spec.yaw,
      agents,
      grow: heightFactor(agents),
      h: buildingHeight(type, agents),
    });
  });

  const gap = LOT.pitch - LOT.size;
  const drafts = [];
  list.forEach((space) => {
    if (space?.kind !== "context") return;
    const seen = new Set();
    const members = (
      projectsBySpace && Array.isArray(projectsBySpace[space.id])
        ? projectsBySpace[space.id]
        : (projects ?? []).filter((p) => Array.isArray(p?.spaceIds) && p.spaceIds.includes(space.id))
    ).filter((p) => p && typeof p.id === "string" && !seen.has(p.id) && seen.add(p.id));
    if (!members.length) return;
    const sorted = members
      .map((p) => ({ projectId: p.id, name: String(p.name ?? p.id), agents: own(agentCountByProject, p.id) }))
      .sort((a, b) => b.agents - a.agents || a.name.localeCompare(b.name, "es") || (a.projectId < b.projectId ? -1 : 1));
    const shown = sorted.slice(0, perDistrict);
    const { cols, rows } = districtGrid(shown.length);
    drafts.push({
      space,
      shown,
      total: sorted.length,
      cols,
      rows,
      w: cols * LOT.pitch - gap + 2 * LOT.pad,
      d: rows * LOT.pitch - gap + 2 * LOT.pad,
    });
  });

  let ground = { w: GROUND.w, d: GROUND.d, cx: 0, cz: 0 };
  const roads = [];
  const lamps = [];
  const districts = [];
  if (drafts.length) {
    const row = drafts.reduce((sum, dr) => sum + dr.w, 0) + DISTRICT.gap * (drafts.length - 1);
    const width = Math.max(GROUND.w, row + 2 * DISTRICT.margin);
    const deepest = Math.max(...drafts.map((dr) => dr.d));
    const zEnd = DISTRICT.z0 + deepest + DISTRICT.margin;
    ground = { w: width, d: zEnd + GROUND.d / 2, cx: 0, cz: (zEnd - GROUND.d / 2) / 2 };
    let x = -row / 2;
    for (const dr of drafts) {
      const lots = dr.shown.map((p, k) => {
        const r = Math.floor(k / dr.cols);
        const c = k % dr.cols;
        return {
          projectId: p.projectId,
          name: p.name,
          agents: p.agents,
          floors: lotFloors(p.agents),
          x: x + LOT.pad + c * LOT.pitch + LOT.size / 2,
          z: DISTRICT.z0 + LOT.pad + r * LOT.pitch + LOT.size / 2,
          w: LOT.size,
          d: LOT.size,
          h: lotHeight(p.agents),
          row: r,
          col: c,
        };
      });
      districts.push({
        spaceId: dr.space.id,
        name: String(dr.space.name ?? dr.space.id),
        x0: x,
        z0: DISTRICT.z0,
        w: dr.w,
        d: dr.d,
        cols: dr.cols,
        rows: dr.rows,
        total: dr.total,
        overflow: dr.total - dr.shown.length,
        lots,
        sign: { x: x + dr.w / 2, z: DISTRICT.z0 + dr.d },
        more: { x: x + dr.w, z: DISTRICT.z0 + dr.d },
      });
      x += dr.w + DISTRICT.gap;
    }
    roads.push({ x: 0, z: BOULEVARD.z, w: width - 1.6, d: BOULEVARD.d });
    const joinFrom = GROUND.d / 2 - 4; // where the street segments of the core end (z = 13)
    const joinTo = BOULEVARD.z - BOULEVARD.d / 2;
    for (const r of ROAD_SEGMENTS.slice(1))
      roads.push({ x: r.x, z: (joinFrom + joinTo) / 2, w: r.w, d: joinTo - joinFrom });
    const n = Math.max(1, Math.round((width - 6) / 12));
    for (let i = 0; i <= n; i++)
      lamps.push({
        x: -width / 2 + 3 + (i * (width - 6)) / n,
        z: BOULEVARD.z - BOULEVARD.d / 2 - 0.5,
        tone: i % 2 ? "amber" : "mint",
      });
  }

  const solids = [
    ...buildings.map((b) => ({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2, h: b.h })),
    ...districts.flatMap((dist) =>
      dist.lots.map((l) => ({ x0: l.x - l.w / 2, x1: l.x + l.w / 2, z0: l.z - l.d / 2, z1: l.z + l.d / 2, h: l.h })),
    ),
  ];
  return {
    buildings,
    districts,
    roads,
    lamps,
    ground,
    bounds: {
      minX: ground.cx - ground.w / 2,
      maxX: ground.cx + ground.w / 2,
      minZ: ground.cz - ground.d / 2,
      maxZ: ground.cz + ground.d / 2,
    },
    camera: cameraFit(ground, solids),
  };
}
