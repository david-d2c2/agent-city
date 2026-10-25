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
const ISO = 1 / Math.sqrt(3);
export function cameraRig(aspect, scale = 1, target = { x: 0, y: 0, z: 0 }) {
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(2, Math.max(0.65, scale)) : 1;
  const fitW = 66;
  const fitH = 47;
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
