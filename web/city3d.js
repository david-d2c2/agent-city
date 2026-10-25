// 3D isometric colony built only from THREE primitives and procedural canvas textures.
// Layout data lives in city3d-layout.js (pure). The renderer/canvas is a module-level
// singleton so re-rendering the app never accumulates WebGL contexts.
import * as THREE from "./vendor/three.module.js";
import { roleIdsForSpace } from "./model.js";
import {
  BUILDINGS,
  GROUND,
  LAMPS,
  PLAZA,
  ROAD_SEGMENTS,
  assignTypes,
  cameraRig,
  robotSlots,
  streetPath,
} from "./city3d-layout.js";

const MIN_SCALE = 0.65;
const MAX_SCALE = 2;
const BASE_GLOW = 0.85;
const TARGET_Y = 4;
const PAN_LIMIT = 26;
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
  const { onSpace, onRole, onFallback } = options;
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
  let tx = 0;
  let tz = 0;
  let selectedId = options.selectedSpace ?? null;
  let liveData = { bySpace: {}, byRole: {} };
  let hoverRole = null;
  let hoverSpace = null;
  let needMeasure = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0c1822, 110, 230);
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
  const hw = GROUND.w / 2 - 0.25;
  const hd = GROUND.d / 2 - 0.25;
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
  groundGeo.translate(0, -(depth + 0.25), 0);
  const ground = new THREE.Mesh(groundGeo, [
    std("#ffffff", { map: groundTex(), roughness: 0.9, metalness: 0 }),
    M.navy,
  ]);
  ground.receiveShadow = true;
  scene.add(ground);
  for (const [w, d, x, z] of [
    [GROUND.w - 0.8, 0.12, 0, -(GROUND.d / 2 - 0.4)],
    [GROUND.w - 0.8, 0.12, 0, GROUND.d / 2 - 0.4],
    [0.12, GROUND.d - 0.8, -(GROUND.w / 2 - 0.4), 0],
    [0.12, GROUND.d - 0.8, GROUND.w / 2 - 0.4, 0],
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
  ROAD_SEGMENTS.forEach((r, i) => {
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
    const n = LAMPS.length;
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
    LAMPS.forEach((l, i) => {
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
  key.position.set(-8, 36, 16);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 8, far: 110 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 3;
  scene.add(hemi, key, key.target);

  // ---- building models
  const builders = {
    office(g, b, glow) {
      const s = facadeMat("strips", "#6a8190", glow);
      box(g, M.steel, 6.4, 0.45, 6.4, 0, 0, 0);
      fbox(g, s, M.ti, 5.6, 6, 5.6, 0, 0.45, 0);
      posts(g, M.ti, 5.6, 6, 5.6, 0.45);
      fbox(g, s, M.ti, 4.5, 4.2, 4.5, 0, 6.45, 0);
      fbox(g, s, M.ti, 3.3, 2.4, 3.3, 0, 10.65, 0);
      box(g, M.mint, 3.5, 0.16, 3.5, 0, 13.05, 0);
      box(g, M.amber, 5.7, 0.07, 0.07, 0, 6.45, 2.85);
      box(g, M.amber, 0.07, 0.07, 5.7, 2.85, 6.45, 0);
      cyl(g, M.ti, 0.06, 0.09, 2.6, 0, 13.2, 0, 8);
      sphere(g, M.amber, 0.13, 0, 15.9, 0);
      doorway(g, b);
      return { ringY: 13.3, ringR: 2.3, beamY: 13.3 };
    },
    home(g, b, glow) {
      cyl(g, M.steel, 3.5, 3.7, 0.6, 0, 0, 0, 40);
      const ringMat = facadeMat("ring", "#7d95a0", glow);
      const band = new THREE.CylinderGeometry(3.2, 3.2, 0.9, 40, 1, true);
      scaleUV(band, 3, 1);
      add(g, band, ringMat, 0, 1.05, 0).material.side = THREE.DoubleSide;
      add(
        g,
        new THREE.SphereGeometry(3.15, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
        M.dome,
        0,
        1.5,
        0,
      );
      for (let i = 0; i < 6; i++) {
        const rib = add(g, new THREE.TorusGeometry(3.19, 0.07, 6, 32, Math.PI), M.ti, 0, 1.5, 0);
        rib.rotation.y = (i * Math.PI) / 6;
      }
      const eq = add(g, new THREE.TorusGeometry(2.7, 0.06, 6, 40), M.ti, 0, 3.2, 0);
      eq.rotation.x = Math.PI / 2;
      const base = add(g, new THREE.TorusGeometry(3.55, 0.05, 6, 48), M.mint, 0, 0.62, 0);
      base.rotation.x = Math.PI / 2;
      box(g, M.dark, 0.9, 1.5, 1.4, 3.35, 0.6, 0);
      box(g, M.amber, 0.92, 0.07, 1.5, 3.36, 2.1, 0);
      cyl(g, M.ti, 0.05, 0.05, 0.9, 0, 4.6, 0, 8);
      sphere(g, M.amber, 0.12, 0, 5.55, 0);
      return { ringY: 4.5, ringR: 1.9, beamY: 5 };
    },
    library(g, b, glow) {
      const s = facadeMat("bands", "#6d8590", glow);
      box(g, M.steel, 6.4, 0.35, 6.4, 0, 0, 0);
      fbox(g, s, M.tiDark, 6, 2.4, 6, 0, 0.35, 0);
      fbox(g, s, M.tiDark, 5.1, 2, 5.2, -0.3, 2.75, 0);
      fbox(g, s, M.tiDark, 4.2, 1.7, 4.4, -0.6, 4.75, 0);
      box(g, M.glass, 2, 0.35, 1.6, -0.9, 6.45, 0);
      for (const z of [-1.8, 0, 1.8]) box(g, M.ti, 0.2, 2.4, 0.3, 3.1, 0.35, z);
      box(g, M.mint, 0.06, 0.07, 5.8, 3.04, 2.7, 0);
      cyl(g, M.ti, 0.1, 0.1, 0.5, 1.3, 6.45, 1.2, 8);
      doorway(g, b);
      return { ringY: 6.6, ringR: 2.7, beamY: 6.6 };
    },
    workshop(g, b, glow) {
      const s = facadeMat("ribs", "#6c7f89", glow);
      box(g, M.steel, 6.4, 0.35, 8.4, 0, 0, 0);
      fbox(g, s, M.tiDark, 6, 2.2, 8, 0, 0.35, 0);
      const vault = new THREE.CylinderGeometry(3, 3, 8, 28, 1, true, Math.PI / 2, Math.PI);
      scaleUV(vault, 4, 3);
      vault.rotateX(Math.PI / 2);
      const v = add(g, vault, s, 0, 2.55, 0);
      v.material = facadeMat("ribs", "#79909a", glow);
      v.material.side = THREE.DoubleSide;
      for (const z of [-4, 4]) {
        const cap = add(g, new THREE.CircleGeometry(3, 28, 0, Math.PI), M.tiDark, 0, 2.55, z);
        cap.material = M.tiDark;
      }
      for (const z of [-3, -1, 1, 3]) add(g, new THREE.TorusGeometry(3.04, 0.07, 6, 28, Math.PI), M.ti, 0, 2.55, z);
      box(g, M.dark, 0.14, 1.7, 3.6, 3.02, 0.35, 0);
      box(g, M.amber, 0.16, 0.08, 3.8, 3.03, 2.05, 0);
      cyl(g, M.ti, 0.12, 0.14, 3, -1.5, 5.0, -3, 10);
      box(g, M.ti, 4, 0.2, 0.2, 0.3, 7.9, -3);
      cyl(g, M.tiDark, 0.02, 0.02, 1.3, 1.8, 6.6, -3, 6);
      box(g, M.amber, 0.24, 0.2, 0.24, 1.8, 6.45, -3);
      return { ringY: 5.65, ringR: 2.3, beamY: 5.7 };
    },
    studio(g, b, glow) {
      const s = facadeMat("panes", "#6e8993", glow);
      box(g, M.steel, 7, 0.35, 7, 0, 0, 0);
      fbox(g, s, M.tiDark, 5.4, 4, 5.4, 0, 0.35, 0);
      posts(g, M.ti, 5.4, 4, 5.4, 0.35);
      fbox(g, s, M.tiDark, 1.3, 2.2, 2.3, 3.3, 0.35, -1.95);
      fbox(g, s, M.tiDark, 1.3, 2.2, 2.3, 3.3, 0.35, 1.95);
      for (const [z, t] of [[-1.8, 0.4], [0, -0.4], [1.8, 0.4]]) {
        const p = box(g, M.glass, 5.2, 0.12, 1.7, 0, 4.4, z);
        p.rotation.x = t;
      }
      cyl(g, M.ti, 0.3, 0.3, 1.6, 1.6, 4.35, 1.7, 12);
      cyl(g, M.ti, 0.08, 0.1, 2.2, -1.7, 4.35, -1.7, 8);
      const dishG = new THREE.Group();
      dishG.position.set(-1.7, 6.5, -1.7);
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
      sphere(g, M.amber, 0.1, -1.7, 6.55, -1.7);
      doorway(g, { w: 5.4 });
      return { ringY: 4.7, ringR: 3.3, beamY: 4.8 };
    },
    control(g, b, glow) {
      const s = facadeMat("bands", "#6a8591", glow);
      box(g, M.steel, 5, 1.2, 5, 0, 0, 0);
      fbox(g, s, M.ti, 2.2, 8, 2.2, 0, 1.2, 0);
      posts(g, M.ti, 2.2, 8, 2.2, 1.2);
      cyl(g, M.tiDark, 1.6, 1.3, 0.4, 0, 9.2, 0, 24);
      cyl(g, M.ti, 2.5, 2.5, 0.35, 0, 9.6, 0, 40);
      const tor = add(g, new THREE.TorusGeometry(2.5, 0.05, 6, 48), M.mint, 0, 9.95, 0);
      tor.rotation.x = Math.PI / 2;
      cyl(g, facadeMat("ring", "#4f7683", glow), 1.3, 1.3, 1.1, 0, 9.95, 0, 24);
      cyl(g, M.tiDark, 0.3, 1.35, 0.4, 0, 11.05, 0, 24);
      cyl(g, M.ti, 0.05, 0.07, 2.5, 0, 11.4, 0, 8);
      sphere(g, M.amber, 0.24, 0, 14.15, 0);
      box(g, M.dark, 0.14, 1.6, 1.3, 2.52, 0, 0);
      box(g, M.amber, 0.16, 0.07, 1.4, 2.53, 1.6, 0);
      return { ringY: 10.1, ringR: 2.9, beamY: 11.3 };
    },
  };

  // ---- buildings
  const spaces = organization?.spaces ?? [];
  const types = assignTypes(spaces);
  const buildings = [];
  const pickRoots = [];
  const beamGeo = track(new THREE.CylinderGeometry(0.35, 0.9, 12, 20, 1, true));
  const arcGeo = track(new THREE.TorusGeometry(1, 0.05, 6, 56, 4.4));
  arcGeo.rotateX(Math.PI / 2);
  const ringGeo = track(new THREE.RingGeometry(Math.SQRT2, Math.SQRT2 * 1.07, 4));
  ringGeo.rotateZ(Math.PI / 4);
  ringGeo.rotateX(-Math.PI / 2);

  spaces.forEach((space, index) => {
    const type = types[index];
    const spec = type && BUILDINGS[type];
    if (!spec || !builders[type]) return;
    const group = new THREE.Group();
    group.position.set(spec.x, 0, spec.z);
    group.rotation.y = spec.yaw;
    group.userData.spaceId = space.id;
    const glow = [];
    const fx = builders[type](group, spec, glow);
    bakeGroup(group);
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

    const ids = new Set(roleIdsForSpace(organization, space.id));
    const roles = (visible ?? [])
      .filter((r) => r.kind === "role" && ids.has(r.id))
      .slice(0, 3);
    buildings.push({
      space, type, spec, group, glow, effects, beamMat, arc, arcMat, sel, selMat,
      roles, light: null, state: null, label: null, labelW: 90, labelH: 36,
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
        role, group, visorMat, building: b, index: i,
        slot: slots[i], goal: { x: path[1].x, z: path[1].z + (i - 1) * 0.9 },
        state: null, hover: false, button: null,
      });
    });
  });

  // ---- overlays (labels, robot buttons, caption)
  const layer = document.createElement("div");
  layer.className = "map-labels-3d";
  const caption = document.createElement("div");
  caption.className = "map-caption-3d";
  caption.setAttribute("aria-hidden", "true");
  caption.textContent = "AGENT CITY / COLONIA LOCAL / SECTOR 01";
  Object.assign(caption.style, {
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
    b.base = `Entrar en ${b.space.name}`;
    label.setAttribute("aria-label", b.base);
    const name = document.createElement("span");
    name.className = "label-3d-name";
    name.textContent = b.space.name;
    const count = document.createElement("span");
    count.className = "label-3d-count";
    count.textContent = `${b.roles.length} ${b.roles.length === 1 ? "rol" : "roles"}`;
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

  // ---- state application
  const summary = (entry) => {
    const { working = 0, waiting = 0 } = entry.states ?? {};
    if (working && waiting) return `${entry.count} activas`;
    return waiting ? `${waiting} esperando` : `${working} trabajando`;
  };
  function applyLiveInternal(bySpace, byRole) {
    liveData = { bySpace: bySpace ?? {}, byRole: byRole ?? {} };
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
        b.light.position.set(0, b.spec.h + 1, 0);
        b.group.add(b.light);
      }
    }
    for (const r of robots) {
      const sessions = liveData.byRole[r.role.id];
      const list = Array.isArray(sessions) ? sessions : [];
      r.state = !list.length
        ? null
        : list.some((s) => s?.state !== "waiting")
          ? "working"
          : "waiting";
      r.visorMat.color.set(r.state === "working" ? live_ : r.state === "waiting" ? wait_ : "#8ad2c0");
      if (!r.state || reduced) resetRobot(r);
    }
    needMeasure = true;
    paintBuildings(now());
    invalidate();
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
    const rig = cameraRig(w / h, scale, { x: tx, y: TARGET_Y, z: tz });
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
  function positionOverlays() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 2 || h < 2) return;
    if (needMeasure) {
      for (const b of buildings) {
        b.countEl.style.display = w < 420 ? "none" : "";
        b.labelW = b.label.offsetWidth || 90;
        b.labelH = b.label.offsetHeight || 24;
      }
      needMeasure = false;
    }
    // Anchor each label just below the front ground corner of its footprint, then
    // spread overlapping rectangles apart with a bounded relaxation pass.
    const rects = buildings.map((b) => {
      v3.set(b.spec.x + b.spec.w / 2, 0, b.spec.z + b.spec.d / 2).project(camera);
      return {
        b,
        w: b.labelW,
        h: b.labelH,
        x: (v3.x * 0.5 + 0.5) * w,
        y: (-v3.y * 0.5 + 0.5) * h + 6,
      };
    });
    const fit = (q) => {
      q.x = clamp(q.x, q.w / 2 + 2, Math.max(q.w / 2 + 2, w - q.w / 2 - 2));
      q.y = clamp(q.y, 2, Math.max(2, h - q.h - 2));
    };
    rects.forEach(fit);
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
      rects.forEach(fit);
      if (!moved) break;
    }
    for (const q of rects)
      q.b.label.style.transform = `translate(${q.x.toFixed(1)}px,${q.y.toFixed(1)}px) translate(-50%,0)`;
    for (const r of robots) {
      v3.set(r.group.position.x, 0.9, r.group.position.z).project(camera);
      const x = (v3.x * 0.5 + 0.5) * w;
      const y = (-v3.y * 0.5 + 0.5) * h;
      r.button.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)`;
    }
  }

  // ---- loop
  const now = () => performance.now() / 1000;
  const animating = () =>
    !reduced &&
    !document.hidden &&
    (buildings.some((b) => b.state) || robots.some((r) => r.state === "working"));
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
  const ndc = new THREE.Vector2();
  function pickAt(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickRoots, true)[0];
    for (let o = hit?.object; o; o = o.parent) {
      if (o.userData.roleId) return { role: o.userData.roleId };
      if (o.userData.spaceId) return { space: o.userData.spaceId };
    }
    return null;
  }
  function setHover(role, space) {
    if (role === hoverRole && space === hoverSpace) return;
    hoverRole = role;
    hoverSpace = space;
    for (const r of robots) r.hover = r.role.id === role;
    canvas.style.cursor = role || space ? "pointer" : "";
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
    setHover(hit?.role ?? null, hit?.space ?? null);
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
    tx = clamp(tx + (-(Number(dx) || 0) * k - (Number(dy) || 0) * up) * wpp, -PAN_LIMIT, PAN_LIMIT);
    tz = clamp(tz + ((Number(dx) || 0) * k - (Number(dy) || 0) * up) * wpp, -PAN_LIMIT, PAN_LIMIT);
    applyCamera();
    invalidate();
  }
  function reset() {
    if (disposed) return;
    scale = 1;
    tx = tz = 0;
    applyCamera();
    invalidate();
  }
  function setSelected(id) {
    if (disposed) return;
    selectedId = id ?? null;
    for (const b of buildings) b.label.classList.toggle("selected", b.space.id === selectedId);
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
    applyLiveInternal(initialLive?.bySpace, initialLive?.byRole);
    invalidate();
  }

  const handle = {
    zoom,
    pan,
    reset,
    setSelected,
    applyLive(bySpace, byRole) {
      if (!disposed) applyLiveInternal(bySpace, byRole);
    },
    stats() {
      const i = renderer.info;
      return {
        drawCalls: i.render.calls,
        triangles: i.render.triangles,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
      };
    },
    dispose,
  };
  const api = { handle, start, dispose, fallback, invalidate };
  return api;
}
