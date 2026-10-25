// 3D isometric colony built only from THREE primitives and procedural canvas textures.
// Layout data lives in city3d-layout.js (pure). The renderer/canvas is a module-level
// singleton so re-rendering the app never accumulates WebGL contexts.
import * as THREE from "./vendor/three.module.js";
import { buildingCounts, buildingRoles, groupKey, projectsForSpace, roleIdsForSpace } from "./model.js";
import {
  BUILDINGS,
  GROUND,
  LAMPS,
  LOT,
  PLAZA,
  ROAD_SEGMENTS,
  cameraRig,
  cityPlan,
  robotSlots,
  streetPath,
} from "./city3d-layout.js";

const MIN_SCALE = 0.65;
const MAX_SCALE = 2;
const BASE_GLOW = 0.85;
const TARGET_Y = 4;
const KEY_LIGHT = 3.0;
const HEMI_LIGHT = 1.1;
const ROBOT_SCALE = 1.25;

// ---------------------------------------------------------------- feature test
let webglOk;
export function webglAvailable() {
  if (webglOk !== undefined) return webglOk;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    webglOk = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglOk = false;
  }
  return webglOk;
}

// ---------------------------------------------------------------- shared renderer
let shared = null; // { renderer, canvas }
let current = null; // active city (internal)

function getRenderer() {
  if (shared) {
    let lost = true;
    try {
      lost = shared.renderer.getContext().isContextLost();
    } catch {
      lost = true;
    }
    if (!lost) return shared;
    try {
      shared.renderer.dispose();
    } catch {
      /* already gone */
    }
    shared = null;
  }
  if (!webglAvailable()) throw new Error("webgl-unavailable");
  let renderer;
  const canvas = document.createElement("canvas");
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    throw new Error("webgl-unavailable");
  }
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvas.setAttribute("aria-hidden", "true");
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    current?.fallback();
  });
  canvas.addEventListener("webglcontextrestored", () => current?.invalidate());
  shared = { renderer, canvas };
  return shared;
}

// ---------------------------------------------------------------- procedural textures
const texCache = new Map();
function cached(key, make) {
  let v = texCache.get(key);
  if (!v) {
    v = make();
    texCache.set(key, v);
  }
  return v;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function facadeTex(style) {
  return cached("facade:" + style, () => {
    const S = 256;
    const r = rng(style.length * 131 + style.charCodeAt(0));
    const mc = document.createElement("canvas");
    const ec = document.createElement("canvas");
    mc.width = mc.height = ec.width = ec.height = S;
    const gm = mc.getContext("2d");
    const ge = ec.getContext("2d");
    gm.fillStyle = "#5a7381";
    gm.fillRect(0, 0, S, S);
    ge.fillStyle = "#000";
    ge.fillRect(0, 0, S, S);
    const lit = () => {
      const k = r();
      return k < 0.62 ? "#f0fff6" : k < 0.85 ? "#8ad2c0" : "#e5b875";
    };
    const win = (x, y, w, h, p) => {
      gm.fillStyle = "#0e2230";
      gm.fillRect(x, y, w, h);
      if (r() < p) {
        ge.fillStyle = lit();
        ge.fillRect(x + 1, y + 1, w - 2, h - 2);
      }
    };
    if (style === "strips") {
      for (let c = 0; c < 6; c++) {
        const x = c * 42 + 9;
        gm.fillStyle = "#0e2230";
        gm.fillRect(x, 6, 24, S - 12);
        let y = 8;
        while (y < S - 14) {
          const len = 14 + Math.floor(r() * 36);
          if (r() < 0.62) {
            ge.fillStyle = lit();
            ge.fillRect(x + 2, y, 20, Math.min(len, S - 10 - y));
          }
          y += len + 6;
        }
      }
    } else if (style === "bands") {
      for (let row = 0; row < 4; row++) {
        const y = row * 64 + 22;
        gm.fillStyle = "#0e2230";
        gm.fillRect(6, y, S - 12, 18);
        let x = 8;
        while (x < S - 12) {
          const len = 20 + Math.floor(r() * 50);
          if (r() < 0.8) {
            ge.fillStyle = r() < 0.8 ? "#8ad2c0" : "#e5b875";
            ge.fillRect(x, y + 3, Math.min(len, S - 10 - x), 12);
          }
          x += len + 5;
        }
      }
    } else if (style === "panes") {
      for (let cx = 0; cx < 2; cx++)
        for (let cy = 0; cy < 3; cy++) win(cx * 128 + 12, cy * 85 + 10, 104, 66, 0.8);
    } else if (style === "ribs") {
      gm.fillStyle = "#4a6370";
      for (let x = 0; x < S; x += 16) gm.fillRect(x, 0, 6, S);
      for (let k = 0; k < 7; k++) {
        ge.fillStyle = r() < 0.5 ? "#e5b875" : "#8ad2c0";
        ge.fillRect(Math.floor(r() * 15) * 16 + 7, Math.floor(r() * 12) * 20 + 8, 6, 8);
      }
    } else {
      // "ring": small windows in rows
      for (let row = 0; row < 3; row++)
        for (let c = 0; c < 8; c++) win(c * 32 + 6, row * 80 + 22, 20, 30, 0.7);
    }
    gm.strokeStyle = "#3a505c";
    gm.lineWidth = 2;
    for (let k = 0; k <= S; k += 128) {
      gm.beginPath();
      gm.moveTo(0, k);
      gm.lineTo(S, k);
      gm.moveTo(k, 0);
      gm.lineTo(k, S);
      gm.stroke();
    }
    const mk = (c) => {
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    return { map: mk(mc), emissive: mk(ec) };
  });
}
function groundTex() {
  return cached("ground", () => {
    const t = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = "#1c3040";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#315062";
      g.lineWidth = 2;
      g.strokeRect(0, 0, w, h);
      g.strokeStyle = "#274051";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(128, 0);
      g.lineTo(128, h);
      g.moveTo(0, 128);
      g.lineTo(w, 128);
      g.stroke();
      g.fillStyle = "#3b6070";
      g.fillRect(0, 0, 4, 4);
      g.fillRect(126, 126, 3, 3);
    });
    t.repeat.set(1 / 4, 1 / 4);
    return t;
  });
}
function roadTex() {
  return cached("road", () =>
    canvasTex(128, 32, (g, w) => {
      g.clearRect(0, 0, w, 32);
      g.fillStyle = "#80b7a7";
      g.fillRect(0, 14, 64, 4);
      g.fillStyle = "#3c5a68";
      g.fillRect(0, 2, w, 2);
      g.fillRect(0, 28, w, 2);
    }),
  );
}
function beamAlpha() {
  return cached("beam", () =>
    canvasTex(
      4,
      64,
      (g, w, h) => {
        const gr = g.createLinearGradient(0, 0, 0, h);
        gr.addColorStop(0, "#000");
        gr.addColorStop(1, "#fff");
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
      },
      false,
    ),
  );
}

// ---------------------------------------------------------------- helpers
function cssColor(name, fallback) {
  let v = "";
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    v = "";
  }
  return new THREE.Color(/^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(v) ? v : fallback);
}
function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}
const noRaycast = () => {};
function mergeGeometries(geos, colors) {
  const pos = [];
  const nor = [];
  const uv = [];
  const col = [];
  const idx = [];
  let off = 0;
  geos.forEach((g, gi) => {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
      if (colors) col.push(colors[gi].r, colors[gi].g, colors[gi].b);
    }
    const ix = g.index;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += p.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (colors) out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- city
export function renderCity3D(container, organization, visible, options = {}, live) {
  current?.dispose();
  current = null;
  const { renderer, canvas } = getRenderer();
  if (renderer.getContext().isContextLost()) throw new Error("webgl-unavailable");
  const city = createCity(container, organization, visible, options, renderer, canvas);
  current = city;
  try {
    city.start(live);
  } catch (error) {
    city.dispose();
    current = null;
    throw error instanceof Error ? error : new Error("webgl-unavailable");
  }
  return city.handle;
}

function createCity(container, organization, visible, options, renderer, canvas) {
  const { onSpace, onRole, onProject, onFallback } = options;
  const ac = new AbortController();
  const { signal } = ac;
  const disposables = [];
  const track = (o) => (disposables.push(o), o);
  const live_ = cssColor("--live", "#6fe0ff");
  const wait_ = cssColor("--live-wait", "#ff9d7a");
  const reducedMq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reduced = !!reducedMq?.matches;
  let disposed = false;
  let fellBack = false;
  let sized = false;
  let dirty = true;
  let raf = 0;
  let errors = 0;
  let scale = 1;
  let liveLots = [];
  let selectedId = options.selectedSpace ?? null;
  let liveData = { bySpace: {}, byRole: {}, byProject: {} };
  let hoverRole = null;
  let hoverSpace = null;
  let hoverLot = -1;
  let needMeasure = true;

  // ---- plan: building heights, project districts, ground and camera fit (pure, see city3d-layout.js)
  const orgSpaces = organization?.spaces ?? [];
  const projectsBySpace = {};
  if (organization?.projects && organization?.assignments)
    for (const s of orgSpaces)
      if (s.kind === "context") projectsBySpace[s.id] = projectsForSpace(organization, s.id);
  const projectStats = options.agents?.byProject ?? {};
  const plan = cityPlan({
    spaces: orgSpaces,
    projectsBySpace,
    agentCountBySpace: options.agents?.bySpace ?? {},
    agentCountByProject: Object.fromEntries(Object.entries(projectStats).map(([id, st]) => [id, st?.agents ?? 0])),
  });
  const planBySpace = new Map(plan.buildings.map((b) => [b.spaceId, b]));
  const G = plan.ground;
  const bigExtra = Math.max(0, (G.w + G.d) / 2 - 41);
  let selectedProject = options.selectedProject ?? null;
  // The camera target starts where the plan puts it (the origin unless districts or tall roofs need room).
  const home = plan.camera.target;
  const fit = { w: plan.camera.fitW, h: plan.camera.fitH };
  const panLimit = plan.camera.panLimit;
  let tx = home.x;
  let tz = home.z;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0c1822, 110 + bigExtra, 230 + bigExtra);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 300);

  // ---- materials
  const std = (color, opt = {}) =>
    track(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...opt }));
  const basic = (color, opt = {}) => track(new THREE.MeshBasicMaterial({ color, ...opt }));
  const M = {
    steel: std("#2a3f4d"),
    navy: std("#16293a", { roughness: 0.75 }),
    ti: std("#a7b6b8", { roughness: 0.45, metalness: 0.3 }),
    tiDark: std("#6f8590", { roughness: 0.5, metalness: 0.3 }),
    dark: std("#0d1b27", { roughness: 0.9, metalness: 0 }),
    glass: std("#1c4a56", { roughness: 0.25, metalness: 0.3 }),
    dome: std("#9fbac0", { roughness: 0.4, metalness: 0.25 }),
    road: std("#1e303c", { roughness: 0.95, metalness: 0 }),
    plaza: std("#2a4452", { roughness: 0.8 }),
    pad: std("#203746", { roughness: 0.95, metalness: 0 }),
    lotBase: std("#4d6a7a", { roughness: 0.7, metalness: 0.15 }),
    mint: basic("#8ad2c0"),
    amber: basic("#e5b875"),
  };
  const facadeMat = (style, color, glow) => {
    const f = facadeTex(style);
    const m = std(color, {
      map: f.map,
      emissive: 0xffffff,
      emissiveMap: f.emissive,
      emissiveIntensity: BASE_GLOW,
      roughness: 0.55,
      metalness: 0.15,
    });
    glow.push(m);
    return m;
  };

  // ---- mesh helpers (yBottom based)
  const add = (parent, geo, mat, x, y, z) => {
    const m = new THREE.Mesh(track(geo), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (p, mat, w, h, d, x, y, z) =>
    add(p, new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z);
  const fbox = (p, side, roof, w, h, d, x, y, z) => {
    const geo = scaleUV(
      new THREE.BoxGeometry(w, h, d),
      Math.max(1, Math.round((w + d) / 6)),
      Math.max(1, Math.round(h / 4)),
    );
    return add(p, geo, [side, side, roof, roof, side, side], x, y + h / 2, z);
  };
  const cyl = (p, mat, rt, rb, h, x, y, z, seg = 24) =>
    add(p, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y + h / 2, z);
  const sphere = (p, mat, r, x, y, z) =>
    add(p, new THREE.SphereGeometry(r, 14, 10), mat, x, y, z);
  const posts = (p, mat, w, h, d, y) => {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) box(p, mat, 0.2, h, 0.2, (sx * w) / 2, y, (sz * d) / 2);
  };
  const doorway = (p, b, y = 0) => {
    box(p, M.dark, 0.14, 1.7, 1.5, b.w / 2 + 0.02, y, 0);
    box(p, M.amber, 0.16, 0.08, 1.7, b.w / 2 + 0.03, y + 1.7, 0);
  };

  // Merges single-material meshes that share a parent into one draw call (static decor only).
  const mergeMeshes = (parent, meshes, material) => {
    const geos = meshes.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const merged = new THREE.Mesh(track(mergeGeometries(geos)), material);
    merged.castShadow = meshes.some((m) => m.castShadow);
    merged.receiveShadow = true;
    geos.forEach((g) => g.dispose());
    meshes.forEach((m) => parent.remove(m));
    parent.add(merged);
    return merged;
  };
  const bakeGroup = (group) => {
    const by = new Map();
    for (const c of group.children) {
      if (!c.isMesh || Array.isArray(c.material) || !c.geometry.index) continue;
      if (!by.has(c.material)) by.set(c.material, []);
      by.get(c.material).push(c);
    }
    for (const [mat, list] of by) if (list.length > 1) mergeMeshes(group, list, mat);
  };

  // ---- ground
  const hw = G.w / 2 - 0.25;
  const hd = G.d / 2 - 0.25;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.closePath();
  const depth = GROUND.h - 0.5;
  const groundGeo = track(
    new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: 0.25,
      bevelSize: 0.25,
      bevelSegments: 2,
      steps: 1,
    }),
  );
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(G.cx, -(depth + 0.25), G.cz);
  const ground = new THREE.Mesh(groundGeo, [
    std("#ffffff", { map: groundTex(), roughness: 0.9, metalness: 0 }),
    M.navy,
  ]);
  ground.receiveShadow = true;
  scene.add(ground);
  for (const [w, d, x, z] of [
    [G.w - 0.8, 0.12, G.cx, G.cz - (G.d / 2 - 0.4)],
    [G.w - 0.8, 0.12, G.cx, G.cz + G.d / 2 - 0.4],
    [0.12, G.d - 0.8, G.cx - (G.w / 2 - 0.4), G.cz],
    [0.12, G.d - 0.8, G.cx + G.w / 2 - 0.4, G.cz],
  ]) {
    const edge = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.06, d)), M.mint);
    edge.position.set(x, 0.03, z);
    scene.add(edge);
  }

  // ---- roads with dashed emissive centre lines
  const roadOverlay = basic("#ffffff", {
    map: roadTex(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const roadBases = [];
  const roadOverlays = [];
  [...ROAD_SEGMENTS, ...plan.roads].forEach((r, i) => {
    const base = new THREE.Mesh(track(new THREE.BoxGeometry(r.w, 0.12, r.d)), M.road);
    base.position.set(r.x, 0.06, r.z);
    base.receiveShadow = true;
    roadBases.push(base);
    const along = Math.max(r.w, r.d);
    const across = Math.min(r.w, r.d);
    const geo = track(new THREE.PlaneGeometry(along, across));
    scaleUV(geo, along / 8, 1);
    geo.rotateX(-Math.PI / 2);
    if (r.d > r.w) geo.rotateY(Math.PI / 2);
    const overlay = new THREE.Mesh(geo, roadOverlay);
    overlay.position.set(r.x, 0.125 + i * 0.002, r.z);
    roadOverlays.push(overlay);
  });
  mergeMeshes(scene, roadBases, M.road);
  mergeMeshes(scene, roadOverlays, roadOverlay);

  // ---- plaza
  const plaza = cyl(scene, M.plaza, PLAZA.r, PLAZA.r + 0.2, 0.16, PLAZA.x, 0, PLAZA.z, 56);
  plaza.castShadow = false;
  for (const [a, b, mat] of [
    [3.0, 3.14, M.mint],
    [2.1, 2.2, M.amber],
  ]) {
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(a, b, 72)), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(PLAZA.x, 0.175, PLAZA.z);
    scene.add(ring);
  }
  cyl(scene, M.ti, 0.5, 0.7, 0.5, PLAZA.x, 0.16, PLAZA.z, 8);
  sphere(scene, M.amber, 0.18, PLAZA.x, 0.95, PLAZA.z);

  // ---- lamps (instanced, static decorative lights)
  {
    const lamps = [...LAMPS, ...plan.lamps];
    const n = lamps.length;
    const postMesh = new THREE.InstancedMesh(
      track(new THREE.CylinderGeometry(0.07, 0.1, 2.4, 8)),
      M.tiDark,
      n,
    );
    const tipMesh = new THREE.InstancedMesh(
      track(new THREE.SphereGeometry(0.2, 10, 8)),
      basic("#ffffff"),
      n,
    );
    const m4 = new THREE.Matrix4();
    const c = new THREE.Color();
    lamps.forEach((l, i) => {
      m4.makeTranslation(l.x, 1.2, l.z);
      postMesh.setMatrixAt(i, m4);
      m4.makeTranslation(l.x, 2.5, l.z);
      tipMesh.setMatrixAt(i, m4);
      tipMesh.setColorAt(i, c.set(l.tone === "amber" ? "#e5b875" : "#8ad2c0"));
    });
    postMesh.castShadow = true;
    scene.add(postMesh, tipMesh);
    disposables.push({ dispose: () => (postMesh.dispose(), tipMesh.dispose()) });
  }

  // ---- lights
  const hemi = new THREE.HemisphereLight(0xcfe3ee, 0x22313b, HEMI_LIGHT);
  const key = new THREE.DirectionalLight(0xfff1dc, KEY_LIGHT);
  // The shadow box follows the ground: unchanged for the original city, wider (and sharper) when districts exist.
  const shadowHalf = Math.max(34, Math.hypot(G.w, G.d) / 2 + 2);
  key.position.set(G.cx - 8, 36, G.cz + 16);
  key.target.position.set(G.cx, 0, G.cz);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowHalf > 36 ? 4096 : 2048, shadowHalf > 36 ? 4096 : 2048);
  Object.assign(key.shadow.camera, {
    left: -shadowHalf,
    right: shadowHalf,
    top: shadowHalf,
    bottom: -shadowHalf,
    near: 8,
    far: 110 + bigExtra,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 3;
  scene.add(hemi, key, key.target);

  // ---- building models
  // Each builder takes `t` (0..1, from the unique agents of the building) and interpolates the growable part of its
  // geometry linearly, so the top of the model is lerp(lo, hi, t) = HEIGHT_RANGE[type] (see city3d-layout.js).
  // Facade UV repeats follow the real height (fbox), so windows keep their size when a tower grows.
  const lerp = (a, b, t) => a + (b - a) * t;
  const builders = {
    office(g, b, glow, t) {
      const s = facadeMat("strips", "#6a8190", glow);
      const k = lerp(0.5, 1.7, t);
      const t1 = 6 * k;
      const t2 = 4.2 * k;
      const t3 = 2.4 * k;
      const top = 0.45 + t1 + t2 + t3;
      box(g, M.steel, 6.4, 0.45, 6.4, 0, 0, 0);
      fbox(g, s, M.ti, 5.6, t1, 5.6, 0, 0.45, 0);
      posts(g, M.ti, 5.6, t1, 5.6, 0.45);
      fbox(g, s, M.ti, 4.5, t2, 4.5, 0, 0.45 + t1, 0);
      fbox(g, s, M.ti, 3.3, t3, 3.3, 0, 0.45 + t1 + t2, 0);
      box(g, M.mint, 3.5, 0.16, 3.5, 0, top, 0);
      box(g, M.amber, 5.7, 0.07, 0.07, 0, 0.45 + t1, 2.85);
      box(g, M.amber, 0.07, 0.07, 5.7, 2.85, 0.45 + t1, 0);
      cyl(g, M.ti, 0.06, 0.09, 2.6, 0, top + 0.15, 0, 8);
      sphere(g, M.amber, 0.13, 0, top + 2.85, 0);
      doorway(g, b);
      return { ringY: top + 0.25, ringR: 2.3, beamY: top + 0.25 };
    },
    home(g, b, glow, t) {
      const drum = lerp(0.9, 3.9, t);
      const sy = lerp(0.8, 1.5, t);
      const y0 = 0.6 + drum; // base of the dome
      cyl(g, M.steel, 3.5, 3.7, 0.6, 0, 0, 0, 40);
      const ringMat = facadeMat("ring", "#7d95a0", glow);
      const band = new THREE.CylinderGeometry(3.2, 3.2, drum, 40, 1, true);
      scaleUV(band, 3, Math.max(1, Math.round(drum / 0.9)));
      add(g, band, ringMat, 0, 0.6 + drum / 2, 0).material.side = THREE.DoubleSide;
      const dome = new THREE.Group();
      dome.position.set(0, y0, 0);
      dome.scale.y = sy;
      g.add(dome);
      add(dome, new THREE.SphereGeometry(3.15, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), M.dome, 0, 0, 0);
      for (let i = 0; i < 6; i++) {
        const rib = add(dome, new THREE.TorusGeometry(3.19, 0.07, 6, 32, Math.PI), M.ti, 0, 0, 0);
        rib.rotation.y = (i * Math.PI) / 6;
      }
      const eq = add(dome, new THREE.TorusGeometry(2.7, 0.06, 6, 40), M.ti, 0, 1.7, 0);
      eq.rotation.x = Math.PI / 2;
      const base = add(g, new THREE.TorusGeometry(3.55, 0.05, 6, 48), M.mint, 0, 0.62, 0);
      base.rotation.x = Math.PI / 2;
      box(g, M.dark, 0.9, 1.5, 1.4, 3.35, 0.6, 0);
      box(g, M.amber, 0.92, 0.07, 1.5, 3.36, 2.1, 0);
      cyl(g, M.ti, 0.05, 0.05, 0.9, 0, y0 + 3.1 * sy, 0, 8);
      sphere(g, M.amber, 0.12, 0, y0 + 4.05 * sy, 0);
      return { ringY: y0 + 3 * sy, ringR: 1.9, beamY: y0 + 3.5 * sy };
    },
    library(g, b, glow, t) {
      const s = facadeMat("bands", "#6d8590", glow);
      const k = lerp(0.7, 2.3, t);
      const a = 2.4 * k;
      const c = 2 * k;
      const e = 1.7 * k;
      const top = 0.35 + a + c + e;
      box(g, M.steel, 6.4, 0.35, 6.4, 0, 0, 0);
      fbox(g, s, M.tiDark, 6, a, 6, 0, 0.35, 0);
      fbox(g, s, M.tiDark, 5.1, c, 5.2, -0.3, 0.35 + a, 0);
      fbox(g, s, M.tiDark, 4.2, e, 4.4, -0.6, 0.35 + a + c, 0);
      box(g, M.glass, 2, 0.35, 1.6, -0.9, top, 0);
      for (const z of [-1.8, 0, 1.8]) box(g, M.ti, 0.2, a, 0.3, 3.1, 0.35, z);
      box(g, M.mint, 0.06, 0.07, 5.8, 3.04, 0.3 + a, 0);
      cyl(g, M.ti, 0.1, 0.1, 0.5, 1.3, top, 1.2, 8);
      doorway(g, b);
      return { ringY: top + 0.15, ringR: 2.7, beamY: top + 0.15 };
    },
    workshop(g, b, glow, t) {
      const s = facadeMat("ribs", "#6c7f89", glow);
      const wall = lerp(1.6, 4.4, t);
      const stack = lerp(3, 6, t);
      const ay = 0.35 + wall; // axis of the vault
      box(g, M.steel, 6.4, 0.35, 8.4, 0, 0, 0);
      fbox(g, s, M.tiDark, 6, wall, 8, 0, 0.35, 0);
      const vault = new THREE.CylinderGeometry(3, 3, 8, 28, 1, true, Math.PI / 2, Math.PI);
      scaleUV(vault, 4, 3);
      vault.rotateX(Math.PI / 2);
      const v = add(g, vault, s, 0, ay, 0);
      v.material = facadeMat("ribs", "#79909a", glow);
      v.material.side = THREE.DoubleSide;
      for (const z of [-4, 4]) {
        const cap = add(g, new THREE.CircleGeometry(3, 28, 0, Math.PI), M.tiDark, 0, ay, z);
        cap.material = M.tiDark;
      }
      for (const z of [-3, -1, 1, 3]) add(g, new THREE.TorusGeometry(3.04, 0.07, 6, 28, Math.PI), M.ti, 0, ay, z);
      box(g, M.dark, 0.14, 1.7, 3.6, 3.02, 0.35, 0);
      box(g, M.amber, 0.16, 0.08, 3.8, 3.03, 2.05, 0);
      cyl(g, M.ti, 0.12, 0.14, stack, -1.5, ay + 2.45, -3, 10);
      box(g, M.ti, 4, 0.2, 0.2, 0.3, ay + 2.35 + stack, -3);
      cyl(g, M.tiDark, 0.02, 0.02, 1.3, 1.8, ay + 4.05, -3, 6);
      box(g, M.amber, 0.24, 0.2, 0.24, 1.8, ay + 3.9, -3);
      return { ringY: ay + 3.1, ringR: 2.3, beamY: ay + 3.15 };
    },
    studio(g, b, glow, t) {
      const s = facadeMat("panes", "#6e8993", glow);
      const body = lerp(2.4, 7.4, t);
      const roof = 0.35 + body; // top of the glass block
      const wing = Math.min(2.2, body * 0.6);
      box(g, M.steel, 7, 0.35, 7, 0, 0, 0);
      fbox(g, s, M.tiDark, 5.4, body, 5.4, 0, 0.35, 0);
      posts(g, M.ti, 5.4, body, 5.4, 0.35);
      fbox(g, s, M.tiDark, 1.3, wing, 2.3, 3.3, 0.35, -1.95);
      fbox(g, s, M.tiDark, 1.3, wing, 2.3, 3.3, 0.35, 1.95);
      for (const [z, tilt] of [[-1.8, 0.4], [0, -0.4], [1.8, 0.4]]) {
        const p = box(g, M.glass, 5.2, 0.12, 1.7, 0, roof + 0.05, z);
        p.rotation.x = tilt;
      }
      cyl(g, M.ti, 0.3, 0.3, 1.6, 1.6, roof, 1.7, 12);
      cyl(g, M.ti, 0.08, 0.1, 2.2, -1.7, roof, -1.7, 8);
      const dishG = new THREE.Group();
      dishG.position.set(-1.7, roof + 2.15, -1.7);
      dishG.rotation.z = 0.6;
      g.add(dishG);
      const dish = add(
        dishG,
        new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, 1),
        M.ti,
        0,
        0.6,
        0,
      );
      dish.rotation.x = Math.PI;
      dish.material = M.ti.clone();
      track(dish.material);
      dish.material.side = THREE.DoubleSide;
      cyl(dishG, M.tiDark, 0.03, 0.03, 0.8, 0, 0.4, 0, 6);
      sphere(g, M.amber, 0.1, -1.7, roof + 2.2, -1.7);
      doorway(g, { w: 5.4 });
      return { ringY: roof + 0.35, ringR: 3.3, beamY: roof + 0.45 };
    },
    control(g, b, glow, t) {
      const s = facadeMat("bands", "#6a8591", glow);
      const shaft = lerp(4.8, 16.8, t);
      const dy = shaft - 8; // everything above the shaft rides on it
      box(g, M.steel, 5, 1.2, 5, 0, 0, 0);
      fbox(g, s, M.ti, 2.2, shaft, 2.2, 0, 1.2, 0);
      posts(g, M.ti, 2.2, shaft, 2.2, 1.2);
      cyl(g, M.tiDark, 1.6, 1.3, 0.4, 0, 9.2 + dy, 0, 24);
      cyl(g, M.ti, 2.5, 2.5, 0.35, 0, 9.6 + dy, 0, 40);
      const tor = add(g, new THREE.TorusGeometry(2.5, 0.05, 6, 48), M.mint, 0, 9.95 + dy, 0);
      tor.rotation.x = Math.PI / 2;
      cyl(g, facadeMat("ring", "#4f7683", glow), 1.3, 1.3, 1.1, 0, 9.95 + dy, 0, 24);
      cyl(g, M.tiDark, 0.3, 1.35, 0.4, 0, 11.05 + dy, 0, 24);
      cyl(g, M.ti, 0.05, 0.07, 2.5, 0, 11.4 + dy, 0, 8);
      sphere(g, M.amber, 0.24, 0, 14.15 + dy, 0);
      box(g, M.dark, 0.14, 1.6, 1.3, 2.52, 0, 0);
      box(g, M.amber, 0.16, 0.07, 1.4, 2.53, 1.6, 0);
      return { ringY: 10.1 + dy, ringR: 2.9, beamY: 11.3 + dy };
    },
  };

  // ---- buildings
  const buildings = [];
  const pickRoots = [];
  const beamGeo = track(new THREE.CylinderGeometry(0.35, 0.9, 12, 20, 1, true));
  const arcGeo = track(new THREE.TorusGeometry(1, 0.05, 6, 56, 4.4));
  arcGeo.rotateX(Math.PI / 2);
  const unitBox = track(new THREE.BoxGeometry(1, 1, 1));
  const ringGeo = track(new THREE.RingGeometry(Math.SQRT2, Math.SQRT2 * 1.07, 4));
  ringGeo.rotateZ(Math.PI / 4);
  ringGeo.rotateX(-Math.PI / 2);

  orgSpaces.forEach((space) => {
    const pb = planBySpace.get(space.id);
    const type = pb?.type;
    const spec = type && BUILDINGS[type];
    if (!spec || !builders[type]) return;
    const group = new THREE.Group();
    group.position.set(spec.x, 0, spec.z);
    group.rotation.y = spec.yaw;
    group.userData.spaceId = space.id;
    const glow = [];
    const fx = builders[type](group, spec, glow, pb.grow);
    bakeGroup(group);
    const builtTop = new THREE.Box3().setFromObject(group).max.y;
    scene.add(group);
    pickRoots.push(group);

    const effects = new THREE.Group();
    effects.visible = false;
    effects.position.set(0, 0, 0);
    const beamMat = basic(live_, {
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      alphaMap: beamAlpha(),
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = fx.beamY + 6;
    beam.raycast = noRaycast;
    const arcMat = basic(live_);
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.scale.set(fx.ringR, 1, fx.ringR);
    arc.position.y = fx.ringY;
    arc.raycast = noRaycast;
    effects.add(beam, arc);
    group.add(effects);

    const selMat = basic("#9fd8bb", { transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const sel = new THREE.Mesh(ringGeo, selMat);
    sel.scale.set(spec.w / 2 + 1, 1, spec.d / 2 + 1);
    sel.position.set(spec.x, 0.13, spec.z);
    sel.visible = false;
    sel.raycast = noRaycast;
    scene.add(sel);

    // At most 3 figures are drawn, but the label counts every role of the building.
    const idSet = new Set(roleIdsForSpace(organization, space.id));
    const grouped = options.grouped !== false;
    const { total, shown: roles } = buildingRoles(visible, idSet, grouped);
    // With filters active the label reads «X de Y roles» so a building the filters empty never looks broken.
    const countText = buildingCounts(options.catalog ?? visible, visible, idSet, grouped, options.filtered === true).text;
    // A drawn figure stands for its whole group: it lights when ANY copy of it (in this building's view) is live.
    const copyIds = new Map(
      roles.map((r) => [
        r.id,
        grouped
          ? visible.filter((v) => v.kind === "role" && idSet.has(v.id) && groupKey(v) === groupKey(r)).map((v) => v.id)
          : [r.id],
      ]),
    );
    buildings.push({
      space, type, spec, group, glow, effects, beamMat, arc, arcMat, sel, selMat,
      h: pb.h, grow: pb.grow, agents: pb.agents, builtTop, countText,
      roles, copyIds, total, light: null, state: null, label: null, labelW: 90, labelH: 36,
    });
  });

  // ---- robots (body/head/limbs merged into one vertex-coloured mesh + a visor)
  const robotBody = (() => {
    const specs = [
      [new THREE.BoxGeometry(0.14, 0.45, 0.16), 0, 0.22, 0.13, "#6f8590"],
      [new THREE.BoxGeometry(0.14, 0.45, 0.16), 0, 0.22, -0.13, "#6f8590"],
      [new THREE.BoxGeometry(0.55, 0.62, 0.4), 0, 0.76, 0, "#a7b6b8"],
      [new THREE.BoxGeometry(0.36, 0.3, 0.34), 0, 1.2, 0, "#a7b6b8"],
      [new THREE.BoxGeometry(0.12, 0.42, 0.12), 0, 0.76, 0.34, "#6f8590"],
      [new THREE.BoxGeometry(0.12, 0.42, 0.12), 0, 0.76, -0.34, "#6f8590"],
      [new THREE.CylinderGeometry(0.015, 0.015, 0.2, 5), 0, 1.45, 0, "#6f8590"],
    ];
    const geos = specs.map(([g, x, y, z]) => g.translate(x, y, z));
    const geo = track(mergeGeometries(geos, specs.map((sp) => new THREE.Color(sp[4]))));
    geos.forEach((g) => g.dispose());
    return geo;
  })();
  const robotMat = std("#ffffff", { vertexColors: true, roughness: 0.5, metalness: 0.25 });
  const visorGeo = track(new THREE.BoxGeometry(0.04, 0.12, 0.26));
  const robots = [];
  buildings.forEach((b) => {
    const slots = robotSlots(b.type);
    const path = streetPath(b.type);
    b.roles.forEach((role, i) => {
      const group = new THREE.Group();
      group.userData.roleId = role.id;
      group.scale.setScalar(ROBOT_SCALE);
      const visorMat = basic("#8ad2c0");
      const body = new THREE.Mesh(robotBody, robotMat);
      body.castShadow = true;
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.position.set(0.18, 1.22, 0);
      group.add(body, visor);
      group.position.set(slots[i].x, 0.12, slots[i].z);
      scene.add(group);
      pickRoots.push(group);
      robots.push({
        role, ids: b.copyIds.get(role.id), group, visorMat, building: b, index: i,
        slot: slots[i], goal: { x: path[1].x, z: path[1].z + (i - 1) * 0.9 },
        state: null, hover: false, button: null,
      });
    });
  });

  // ---- districts: one pad per context, project lots as instanced towers (one draw call per storey count)
  const PAD_H = 0.14;
  const hash01 = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return ((h >>> 0) % 1000) / 1000;
  };
  const lots = plan.districts.flatMap((d) =>
    d.lots.map((lot) => ({ lot, district: d, tint: 0.88 + 0.22 * hash01(lot.projectId) })),
  );
  const lotMeshes = []; // every instanced mesh that can be picked: { mesh, ids } (ids: instance -> lot index)
  const lotGlow = [];
  const lotFx = new Map(); // lot index -> live effect objects (created on first use)
  const lotRings = new Map(); // lot index -> selection ring
  let lotHoverRing = null;
  if (lots.length) {
    const pads = [];
    const rims = [];
    for (const d of plan.districts) {
      const pad = new THREE.Mesh(track(new THREE.BoxGeometry(d.w, PAD_H, d.d)), M.pad);
      pad.position.set(d.x0 + d.w / 2, PAD_H / 2, d.z0 + d.d / 2);
      pad.receiveShadow = true;
      pads.push(pad);
      for (const [w, dd, x, z] of [
        [d.w, 0.1, d.x0 + d.w / 2, d.z0 + 0.05],
        [d.w, 0.1, d.x0 + d.w / 2, d.z0 + d.d - 0.05],
        [0.1, d.d, d.x0 + 0.05, d.z0 + d.d / 2],
        [0.1, d.d, d.x0 + d.w - 0.05, d.z0 + d.d / 2],
      ]) {
        const rim = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.05, dd)), M.mint);
        rim.position.set(x, PAD_H + 0.02, z);
        rims.push(rim);
      }
    }
    mergeMeshes(scene, pads, M.pad);
    mergeMeshes(scene, rims, M.mint);

    const m4 = new THREE.Matrix4();
    const lotColor = new THREE.Color();
    const plinthGeo = track(new THREE.BoxGeometry(LOT.size, LOT.plinth, LOT.size));
    plinthGeo.translate(0, LOT.plinth / 2, 0);
    const plinth = new THREE.InstancedMesh(plinthGeo, M.lotBase, lots.length);
    lots.forEach((e, i) => {
      m4.makeTranslation(e.lot.x, PAD_H, e.lot.z);
      plinth.setMatrixAt(i, m4);
      plinth.setColorAt(i, lotColor.setScalar(1));
    });
    const everyLot = lots.map((_, i) => i);
    lotMeshes.push({ mesh: plinth, ids: everyLot });

    const facade = facadeMat("ring", "#6e8993", lotGlow);
    const cap = M.tiDark;
    const byFloors = new Map();
    lots.forEach((e, i) => {
      if (e.lot.floors > 0) byFloors.set(e.lot.floors, [...(byFloors.get(e.lot.floors) ?? []), i]);
    });
    for (const [floors, ids] of byFloors) {
      const h = floors * LOT.floorH;
      const geo = track(new THREE.BoxGeometry(LOT.size - 0.4, h, LOT.size - 0.4));
      geo.translate(0, h / 2, 0);
      // one tile of the "ring" texture is three storeys tall, so windows keep their size at any height
      scaleUV(geo, 1, floors / 3);
      const mesh = new THREE.InstancedMesh(geo, [facade, facade, cap, cap, facade, facade], ids.length);
      ids.forEach((gi, k) => {
        m4.makeTranslation(lots[gi].lot.x, PAD_H + LOT.plinth, lots[gi].lot.z);
        mesh.setMatrixAt(k, m4);
        mesh.setColorAt(k, lotColor.setScalar(1));
      });
      lotMeshes.push({ mesh, ids });
    }
    for (const { mesh } of lotMeshes) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      disposables.push({ dispose: () => mesh.dispose() });
    }
  }
  // Colour per lot: slight variation, dimmer when empty, brighter on hover, mint-tinted when it is the selected project.
  function paintLots() {
    if (!lots.length) return;
    const c = new THREE.Color();
    lotMeshes.forEach(({ mesh, ids }) => {
      ids.forEach((gi, k) => {
        const e = lots[gi];
        const selected = e.lot.projectId === selectedProject;
        const base = e.lot.agents === 0 ? 0.62 : e.tint;
        c.setRGB(base * (selected ? 0.85 : 1), base * (selected ? 1.25 : 1), base * (selected ? 1.05 : 1));
        if (gi === hoverLot) c.multiplyScalar(1.55);
        mesh.setColorAt(k, c);
      });
      mesh.instanceColor.needsUpdate = true;
    });
  }
  if (lots.length) {
    const ring = (opacity) => {
      const mat = basic("#9fd8bb", { transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
      const r = new THREE.Mesh(ringGeo, mat);
      r.scale.set(LOT.size / 2 + 0.45, 1, LOT.size / 2 + 0.45);
      r.visible = false;
      r.raycast = noRaycast;
      scene.add(r);
      return r;
    };
    lots.forEach((e, gi) => {
      if (e.lot.projectId !== selectedProject) return;
      const r = ring(0.95);
      r.position.set(e.lot.x, PAD_H + 0.03, e.lot.z);
      r.visible = true;
      lotRings.set(gi, r);
    });
    lotHoverRing = ring(0.55);
  }

  // ---- overlays (labels, robot buttons, caption)
  const layer = document.createElement("div");
  layer.className = "map-labels-3d";
  const caption = document.createElement("div");
  caption.className = "map-caption-3d";
  caption.setAttribute("aria-hidden", "true");
  // Honest legend: heights are unique agents; lots (only when there are projects) count assigned OR used agents.
  const legend = document.createElement("div");
  legend.textContent = lots.length
    ? "ALTURA = AGENTES ÚNICOS · LOTES: ASIGNADOS O USADOS EN EL PROYECTO"
    : "ALTURA = AGENTES ÚNICOS";
  Object.assign(legend.style, { marginTop: "4px", fontSize: "9px", letterSpacing: "0.1em", opacity: "0.85" });
  caption.append("AGENT CITY / COLONIA LOCAL / SECTOR 01", legend);
  Object.assign(caption.style, {
    textAlign: "center",
    position: "absolute",
    left: "50%",
    bottom: "8px",
    transform: "translateX(-50%)",
    font: '600 10px/1 "Cascadia Mono", Consolas, monospace',
    letterSpacing: "0.14em",
    color: "#8fb0b0",
    opacity: "0.75",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  });
  layer.append(caption);

  const robotsOf = (b) => robots.filter((r) => r.building === b);
  buildings.forEach((b) => {
    const label = document.createElement("button");
    label.type = "button";
    label.className = "label-3d" + (b.space.id === selectedId ? " selected" : "");
    label.dataset.spaceId = b.space.id;
    b.base = `Entrar en ${b.space.name}, ${b.countText}`;
    label.setAttribute("aria-label", b.base);
    const name = document.createElement("span");
    name.className = "label-3d-name";
    name.textContent = b.space.name;
    const count = document.createElement("span");
    count.className = "label-3d-count";
    count.textContent = b.countText;
    Object.assign(count.style, { font: "400 10px/1.2 Segoe UI, sans-serif", opacity: "0.75" });
    const row = document.createElement("span");
    row.className = "label-3d-row";
    Object.assign(row.style, { display: "flex", alignItems: "baseline", gap: "6px" });
    row.append(name, count);
    label.append(row);
    b.countEl = count;
    label.addEventListener("click", () => onSpace?.(b.space.id), { signal });
    const enter = () => setHover(null, b.space.id);
    const leave = () => setHover(null, null);
    label.addEventListener("pointerenter", enter, { signal });
    label.addEventListener("pointerleave", leave, { signal });
    label.addEventListener("focus", enter, { signal });
    label.addEventListener("blur", leave, { signal });
    b.label = label;
    b.nameEl = name;
    layer.append(label);
    robotsOf(b).forEach((r) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "robot-3d";
      btn.setAttribute("aria-label", `Ver ${r.role.name}`);
      Object.assign(btn.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "30px",
        height: "34px",
        padding: "0",
        border: "0",
        background: "transparent",
        pointerEvents: "none",
        borderRadius: "4px",
      });
      btn.addEventListener("click", () => onRole?.(r.role.id), { signal });
      btn.addEventListener("focus", () => setHover(r.role.id, null), { signal });
      btn.addEventListener("blur", () => setHover(null, null), { signal });
      r.button = btn;
      layer.append(btn);
    });
  });

  // ---- district signs, «+N más» markers, lot tooltip and live chips.
  // None of them is a keyboard target on purpose (tabindex -1: still clickable): the sidebar project list and the list
  // view are the equivalent, and the building labels already name the same places.
  const projectsLabel = (n) => `${n} ${n === 1 ? "proyecto" : "proyectos"}`;
  const signs = plan.districts.map((d) => {
    const label = document.createElement("button");
    label.type = "button";
    label.tabIndex = -1;
    label.className = "label-3d district-sign" + (d.spaceId === selectedId ? " selected" : "");
    label.dataset.districtSpaceId = d.spaceId;
    label.setAttribute(
      "aria-label",
      `Entrar en ${d.name}: ${projectsLabel(d.total)}${d.overflow ? `, se dibujan ${d.lots.length}` : ""}`,
    );
    const name = document.createElement("span");
    name.className = "label-3d-name";
    name.textContent = `Proyectos de ${d.name}`;
    const count = document.createElement("span");
    count.className = "label-3d-count";
    count.textContent = `· ${d.total}`;
    Object.assign(count.style, { font: "400 10px/1.2 Segoe UI, sans-serif", opacity: "0.75" });
    const row = document.createElement("span");
    row.className = "label-3d-row";
    Object.assign(row.style, { display: "flex", alignItems: "baseline", gap: "6px" });
    row.append(name, count);
    label.append(row);
    label.addEventListener("click", () => onSpace?.(d.spaceId), { signal });
    label.addEventListener("pointerenter", () => setHover(null, d.spaceId), { signal });
    label.addEventListener("pointerleave", () => setHover(null, null), { signal });
    label.addEventListener("focus", () => setHover(null, d.spaceId), { signal });
    label.addEventListener("blur", () => setHover(null, null), { signal });
    layer.append(label);
    return { d, label, labelW: 120, labelH: 24 };
  });
  const moreChips = plan.districts
    .filter((d) => d.overflow > 0)
    .map((d) => {
      const chip = document.createElement("div");
      chip.className = "lot-more";
      chip.textContent = `+${d.overflow} más`;
      chip.title = `${d.name}: se dibujan ${d.lots.length} de ${d.total} proyectos; el resto está en la lista y en la barra lateral`;
      layer.append(chip);
      return { d, chip };
    });
  const lotTip = document.createElement("div");
  lotTip.className = "lot-tip";
  lotTip.setAttribute("aria-hidden", "true");
  lotTip.hidden = true;
  layer.append(lotTip);
  const agentsText = (n) =>
    n === 0
      ? "Sin agentes asignados ni usados aquí"
      : `${n} ${n === 1 ? "agente" : "agentes"} (${n === 1 ? "asignado o usado" : "asignados o usados"} aquí)`;
  function fillTip(el, gi, withHint) {
    const e = lots[gi];
    const stat = projectStats[e.lot.projectId];
    const live = liveData.byProject[e.lot.projectId];
    const name = document.createElement("strong");
    name.textContent = e.lot.name;
    const lines = [name, agentsText(e.lot.agents)];
    if (stat?.lastAt) lines.push(`Último uso registrado: ${stat.lastAt}`);
    if (live?.count) lines.push(`● ${summary(live)}`);
    if (withHint) lines.push("Clic: ver sus agentes");
    el.replaceChildren(
      ...lines.map((line) => {
        const row = document.createElement("div");
        row.append(line);
        return row;
      }),
    );
  }
  let liveChips = []; // { gi, el } for the lots that are live right now (most active first, at most 4)

  // ---- state application
  const summary = (entry) => {
    const { working = 0, waiting = 0 } = entry.states ?? {};
    if (working && waiting) return `${entry.count} activas`;
    return waiting ? `${waiting} esperando` : `${working} trabajando`;
  };
  function applyLiveInternal(bySpace, byRole, byProject) {
    liveData = { bySpace: bySpace ?? {}, byRole: byRole ?? {}, byProject: byProject ?? {} };
    for (const b of buildings) {
      const entry = liveData.bySpace[b.space.id];
      const on = !!entry && entry.count > 0;
      b.state = on ? (entry.states?.working ? "working" : "waiting") : null;
      b.label.querySelector(":scope > .live-badge")?.remove();
      if (on) {
        const text = summary(entry);
        b.label.dataset.live = b.state;
        b.label.setAttribute("aria-label", `${b.base}. ${text} en vivo`);
        const badge = document.createElement("span");
        badge.className = "live-badge";
        badge.setAttribute("aria-hidden", "true");
        badge.textContent = `● ${text}`;
        b.label.append(badge);
      } else {
        delete b.label.dataset.live;
        b.label.setAttribute("aria-label", b.base);
      }
      if (on && !b.light) {
        b.light = new THREE.PointLight(0xffffff, 0, 16, 2);
        b.light.position.set(0, b.h + 1, 0);
        b.group.add(b.light);
      }
    }
    for (const r of robots) {
      const list = r.ids.flatMap((id) => (Array.isArray(liveData.byRole[id]) ? liveData.byRole[id] : []));
      r.state = !list.length
        ? null
        : list.some((s) => s?.state !== "waiting")
          ? "working"
          : "waiting";
      r.visorMat.color.set(r.state === "working" ? live_ : r.state === "waiting" ? wait_ : "#8ad2c0");
      if (!r.state || reduced) resetRobot(r);
    }
    syncLiveLots();
    needMeasure = true;
    paintBuildings(now());
    invalidate();
  }
  // Lots glow only for real sessions whose folder belongs to the project; chips name the busiest ones.
  function syncLiveLots() {
    if (!lots.length) return;
    liveLots = lots
      .map((e, gi) => ({ gi, n: liveData.byProject[e.lot.projectId]?.count ?? 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || a.gi - b.gi)
      .map((x) => x.gi);
    for (const gi of liveLots) ensureLotFx(gi);
    for (const c of liveChips) c.el.remove();
    if (hoverLot >= 0) fillTip(lotTip, hoverLot, true);
    liveChips = liveLots.slice(0, 4).map((gi) => {
      const el = document.createElement("div");
      el.className = "lot-tip lot-tip-live";
      el.setAttribute("aria-hidden", "true");
      const entry = liveData.byProject[lots[gi].lot.projectId];
      el.textContent = `${lots[gi].lot.name} · ● ${summary(entry)}`;
      layer.append(el);
      return { gi, el };
    });
  }
  function ensureLotFx(gi) {
    let fx = lotFx.get(gi);
    if (fx) return fx;
    const { lot } = lots[gi];
    const group = new THREE.Group();
    group.position.set(lot.x, 0, lot.z);
    const shellMat = basic(live_, {
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const shell = new THREE.Mesh(unitBox, shellMat);
    shell.scale.set(LOT.size + 0.5, lot.h + 0.5, LOT.size + 0.5);
    shell.position.y = PAD_H - 0.05 + (lot.h + 0.5) / 2;
    shell.raycast = noRaycast;
    const beamMat = basic(live_, {
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      alphaMap: beamAlpha(),
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.scale.set(0.5, 0.75, 0.5);
    beam.position.y = PAD_H + lot.h + 0.3 + 4.5;
    beam.raycast = noRaycast;
    const arcMat = basic(live_);
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.scale.set(1.9, 1, 1.9);
    arc.position.y = PAD_H + lot.h + 0.3;
    arc.raycast = noRaycast;
    group.add(shell, beam, arc);
    group.visible = false;
    scene.add(group);
    fx = { group, shell, shellMat, beam, beamMat, arc, arcMat };
    lotFx.set(gi, fx);
    return fx;
  }
  function paintLotFx(t) {
    const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4);
    for (const [gi, fx] of lotFx) {
      const entry = liveData.byProject[lots[gi].lot.projectId];
      const on = !!entry && entry.count > 0;
      fx.group.visible = on;
      if (!on) continue;
      const working = !!entry.states?.working;
      const color = working ? live_ : wait_;
      fx.shellMat.color.copy(color);
      fx.shellMat.opacity = working ? 0.26 : 0.12 + 0.22 * pulse;
      fx.beam.visible = working;
      fx.arc.visible = working;
      fx.beamMat.color.copy(color);
      fx.arcMat.color.copy(color);
      fx.arc.rotation.y = reduced ? 0 : t * 0.6;
    }
  }
  function resetRobot(r) {
    r.group.position.set(r.slot.x, 0.12, r.slot.z);
    r.group.rotation.y = 0;
  }

  const tmpColor = new THREE.Color();
  function paintBuildings(t) {
    for (const b of buildings) {
      let intensity = BASE_GLOW;
      let color = tmpColor.set(0xffffff);
      const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4);
      b.effects.visible = false;
      if (b.light) b.light.visible = false;
      if (b.state === "working") {
        color = tmpColor.copy(live_);
        intensity = BASE_GLOW * 2;
        b.effects.visible = true;
        b.arc.visible = true;
        b.beamMat.color.copy(live_);
        b.arcMat.color.copy(live_);
        b.arc.rotation.y = reduced ? 0 : t * 0.6;
        if (b.light) {
          b.light.visible = true;
          b.light.color.copy(live_);
          b.light.intensity = 40;
        }
      } else if (b.state === "waiting") {
        color = tmpColor.copy(wait_);
        intensity = BASE_GLOW * (1.2 + pulse);
        if (b.light) {
          b.light.visible = true;
          b.light.color.copy(wait_);
          b.light.intensity = 12 + 28 * pulse;
        }
      }
      if (b.space.id === selectedId) intensity *= 1.15;
      for (const m of b.glow) {
        m.emissive.copy(color);
        m.emissiveIntensity = intensity;
      }
      const shown = b.space.id === selectedId || b.space.id === hoverSpace;
      b.sel.visible = shown;
      b.selMat.opacity = b.space.id === selectedId ? 0.95 : 0.5;
    }
    paintLotFx(t);
  }
  function walkRobots(t) {
    for (const r of robots) {
      r.group.scale.setScalar(ROBOT_SCALE * (r.hover ? 1.18 : 1));
      if (r.state !== "working" || reduced) continue;
      const w = t * 0.5 + r.index * 1.7;
      const ph = 0.5 - 0.5 * Math.cos(w);
      const dir = Math.sin(w) >= 0 ? 1 : -1;
      const dz = r.goal.z - r.slot.z;
      r.group.position.x = r.slot.x;
      r.group.position.z = r.slot.z + dz * ph;
      r.group.rotation.y = Math.atan2(-dz * dir, 0.0001);
      r.group.position.y = 0.12 + Math.abs(Math.sin(t * 8 + r.index)) * 0.06;
    }
  }

  // ---- camera
  function applyCamera() {
    const w = canvas.clientWidth || container.clientWidth || 1;
    const h = canvas.clientHeight || container.clientHeight || 1;
    const rig = cameraRig(w / h, scale, { x: tx, y: TARGET_Y, z: tz }, fit);
    camera.left = rig.left;
    camera.right = rig.right;
    camera.top = rig.top;
    camera.bottom = rig.bottom;
    camera.near = rig.near;
    camera.far = rig.far;
    camera.position.set(rig.position.x, rig.position.y, rig.position.z);
    camera.lookAt(tx, TARGET_Y, tz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return rig;
  }

  // ---- overlay projection
  const v3 = new THREE.Vector3();
  const screenOf = (x, y, z, w, h) => {
    v3.set(x, y, z).project(camera);
    return { x: (v3.x * 0.5 + 0.5) * w, y: (-v3.y * 0.5 + 0.5) * h };
  };
  const place = (el, p, anchor) => (el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) ${anchor}`);
  function positionOverlays() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 2 || h < 2) return;
    if (needMeasure) {
      for (const b of buildings) b.countEl.style.display = w < 420 ? "none" : "";
      for (const it of [...buildings, ...signs]) {
        const el = it.label;
        it.labelW = el.offsetWidth || 90;
        it.labelH = el.offsetHeight || 24;
      }
      needMeasure = false;
    }
    // Anchor each label just below the front ground corner of its footprint (district signs: below the front edge of
    // the pad), then spread overlapping rectangles apart with a bounded relaxation pass.
    const rects = [
      ...buildings.map((b) => ({ el: b.label, wx: b.spec.x + b.spec.w / 2, wz: b.spec.z + b.spec.d / 2, w: b.labelW, h: b.labelH })),
      ...signs.map((sg) => ({ el: sg.label, wx: sg.d.sign.x, wz: sg.d.sign.z, w: sg.labelW, h: sg.labelH })),
    ].map((r) => {
      const p = screenOf(r.wx, 0, r.wz, w, h);
      return { el: r.el, w: r.w, h: r.h, x: p.x, y: p.y + 6 };
    });
    const fitRect = (q) => {
      q.x = clamp(q.x, q.w / 2 + 2, Math.max(q.w / 2 + 2, w - q.w / 2 - 2));
      q.y = clamp(q.y, 2, Math.max(2, h - q.h - 2));
    };
    rects.forEach(fitRect);
    for (let it = 0; it < 10; it++) {
      let moved = false;
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const c = rects[j];
          const ox = (a.w + c.w) / 2 + 3 - Math.abs(a.x - c.x);
          const cyA = a.y + a.h / 2;
          const cyC = c.y + c.h / 2;
          const oy = (a.h + c.h) / 2 + 3 - Math.abs(cyA - cyC);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (oy <= ox) {
            const d = (cyA <= cyC ? 1 : -1) * (oy / 2);
            a.y -= d;
            c.y += d;
          } else {
            const d = (a.x <= c.x ? 1 : -1) * (ox / 2);
            a.x -= d;
            c.x += d;
          }
        }
      rects.forEach(fitRect);
      if (!moved) break;
    }
    for (const q of rects) place(q.el, q, "translate(-50%,0)");
    for (const r of robots) {
      const p = screenOf(r.group.position.x, 0.9, r.group.position.z, w, h);
      place(r.button, p, "translate(-50%,-50%)");
    }
    for (const { d, chip } of moreChips) place(chip, screenOf(d.more.x, 0, d.more.z, w, h), "translate(-100%,6px)");
    const above = (gi) => {
      const lot = lots[gi].lot;
      return screenOf(lot.x, PAD_H + lot.h, lot.z, w, h);
    };
    lotTip.hidden = hoverLot < 0;
    if (hoverLot >= 0) {
      const p = above(hoverLot);
      const half = (lotTip.offsetWidth || 160) / 2 + 2;
      p.x = clamp(p.x, half, Math.max(half, w - half));
      p.y = Math.max(p.y, (lotTip.offsetHeight || 60) + 12);
      place(lotTip, p, "translate(-50%,-100%) translateY(-8px)");
    }
    for (const c of liveChips) {
      c.el.hidden = c.gi === hoverLot;
      if (!c.el.hidden) place(c.el, above(c.gi), "translate(-50%,-100%) translateY(-6px)");
    }
  }

  // ---- loop
  const now = () => performance.now() / 1000;
  const animating = () =>
    !reduced &&
    !document.hidden &&
    (buildings.some((b) => b.state) || robots.some((r) => r.state === "working") || liveLots.length > 0);
  function schedule() {
    if (raf || disposed || document.hidden) return;
    raf = requestAnimationFrame(frame);
  }
  function invalidate() {
    dirty = true;
    schedule();
  }
  function draw(t) {
    if (!sized) return;
    walkRobots(t);
    paintBuildings(t);
    renderer.render(scene, camera);
    positionOverlays();
  }
  function frame(ts) {
    raf = 0;
    if (disposed) return;
    try {
      if (dirty || animating()) {
        dirty = false;
        draw(ts / 1000);
        errors = 0;
      }
    } catch {
      if (++errors >= 3) {
        fallback();
        return;
      }
      dirty = true;
    }
    if (animating() || dirty) schedule();
  }
  function fallback() {
    if (fellBack || disposed) return;
    fellBack = true;
    try {
      onFallback?.();
    } catch {
      /* the app decides what to do; never throw into the loop */
    }
  }

  // ---- interaction
  const raycaster = new THREE.Raycaster();
  const pickable = [...pickRoots, ...lotMeshes.map((m) => m.mesh)];
  const ndc = new THREE.Vector2();
  function pickAt(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickable, true)[0];
    if (hit?.instanceId != null) {
      const found = lotMeshes.find((m) => m.mesh === hit.object);
      if (found) return { lot: found.ids[hit.instanceId] };
    }
    for (let o = hit?.object; o; o = o.parent) {
      if (o.userData.roleId) return { role: o.userData.roleId };
      if (o.userData.spaceId) return { space: o.userData.spaceId };
    }
    return null;
  }
  function setHover(role, space, lot = -1) {
    if (role === hoverRole && space === hoverSpace && lot === hoverLot) return;
    const lotChanged = lot !== hoverLot;
    hoverRole = role;
    hoverSpace = space;
    hoverLot = lot;
    for (const r of robots) r.hover = r.role.id === role;
    canvas.style.cursor = role || space || lot >= 0 ? "pointer" : "";
    if (lotChanged) {
      if (lot >= 0) fillTip(lotTip, lot, true);
      if (lotHoverRing) {
        lotHoverRing.visible = lot >= 0;
        if (lot >= 0) lotHoverRing.position.set(lots[lot].lot.x, PAD_H + 0.04, lots[lot].lot.z);
      }
      paintLots();
    }
    invalidate();
  }
  let drag = null;
  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured */
    }
  };
  const onMove = (e) => {
    if (drag && e.pointerId === drag.id) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.moved = true;
      canvas.style.cursor = "grabbing";
      pan(e.clientX - drag.lx, e.clientY - drag.ly);
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      return;
    }
    const hit = pickAt(e);
    setHover(hit?.role ?? null, hit?.space ?? null, hit?.lot ?? -1);
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasClick = !drag.moved;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    canvas.style.cursor = "";
    if (!wasClick) return;
    const hit = pickAt(e);
    if (hit?.role) onRole?.(hit.role);
    else if (hit?.space) onSpace?.(hit.space);
    else if (hit?.lot != null) onProject?.(lots[hit.lot].lot.projectId);
  };
  const onCancel = () => {
    drag = null;
    canvas.style.cursor = "";
  };
  canvas.addEventListener("pointerdown", onDown, { signal });
  canvas.addEventListener("pointermove", onMove, { signal });
  canvas.addEventListener("pointerup", onUp, { signal });
  canvas.addEventListener("pointercancel", onCancel, { signal });
  canvas.addEventListener("pointerleave", () => !drag && setHover(null, null), { signal });
  document.addEventListener("visibilitychange", () => invalidate(), { signal });
  reducedMq?.addEventListener?.(
    "change",
    () => {
      reduced = !!reducedMq.matches;
      if (reduced) robots.forEach(resetRobot);
      invalidate();
    },
    { signal },
  );

  // ---- public operations
  function zoom(delta) {
    if (disposed) return;
    scale = clamp(scale + (Number(delta) || 0), MIN_SCALE, MAX_SCALE);
    applyCamera();
    invalidate();
  }
  function pan(dx, dy) {
    if (disposed) return;
    const h = container.clientHeight || 1;
    const rig = applyCamera();
    const wpp = (rig.top - rig.bottom) / h;
    const k = 0.70710678;
    const up = k * 1.7320508;
    tx = clamp(tx + (-(Number(dx) || 0) * k - (Number(dy) || 0) * up) * wpp, home.x - panLimit, home.x + panLimit);
    tz = clamp(tz + ((Number(dx) || 0) * k - (Number(dy) || 0) * up) * wpp, home.z - panLimit, home.z + panLimit);
    applyCamera();
    invalidate();
  }
  function reset() {
    if (disposed) return;
    scale = 1;
    tx = home.x;
    tz = home.z;
    applyCamera();
    invalidate();
  }
  function setSelected(id) {
    if (disposed) return;
    selectedId = id ?? null;
    for (const b of buildings) b.label.classList.toggle("selected", b.space.id === selectedId);
    for (const sg of signs) sg.label.classList.toggle("selected", sg.d.spaceId === selectedId);
    invalidate();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ac.abort();
    ro?.disconnect();
    for (const b of buildings) {
      b.light?.dispose?.();
    }
    key.shadow.dispose();
    scene.clear();
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    layer.remove();
    if (canvas.parentNode === container) canvas.remove();
    if (current === api) current = null;
  }

  let ro = null;
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    sized = w >= 2 && h >= 2;
    if (!sized) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    applyCamera();
    needMeasure = true;
    invalidate();
  }
  function start(initialLive) {
    container.replaceChildren(canvas, layer);
    canvas.style.cursor = "";
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => resize());
      ro.observe(container);
    }
    resize();
    paintLots();
    applyLiveInternal(initialLive?.bySpace, initialLive?.byRole, initialLive?.byProject);
    invalidate();
  }

  const handle = {
    zoom,
    pan,
    reset,
    setSelected,
    applyLive(bySpace, byRole, byProject) {
      if (!disposed) applyLiveInternal(bySpace, byRole, byProject);
    },
    stats() {
      const i = renderer.info;
      return {
        drawCalls: i.render.calls,
        triangles: i.render.triangles,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        lots: lots.length,
        buildings: buildings.map((b) => ({ spaceId: b.space.id, type: b.type, agents: b.agents, planH: b.h, builtTop: b.builtTop })),
        camera: { home, fit, panLimit },
      };
    },
    dispose,
  };
  const api = { handle, start, dispose, fallback, invalidate };
  return api;
}
