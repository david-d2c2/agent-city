import { buildingCounts, buildingRoles, roleIdsForSpace } from "./model.js";
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
const positions = [
  [240, 256],
  [500, 169],
  [753, 288],
  [272, 492],
  [532, 423],
  [775, 523],
];
function marker(x, y, s = 1) {
  const g = svg("g", { transform: `translate(${x} ${y}) scale(${s})` });
  g.innerHTML =
    '<ellipse cy="10" rx="20" ry="9" fill="#050e18" opacity=".55"/><path d="M-13 8v-21L0-20 13-13V8L0 16Z" fill="#253a46" stroke="#627c87"/><path d="M0-20v-26M-13-13L0-6 13-13" fill="none" stroke="#88b7ac" stroke-width="2"/><circle cy="-47" r="3" fill="#d8b879"/>';
  return g;
}
function architecture(index) {
  const shell =
    '<path d="M-88 7L5-47 104 7 11 62Z" fill="#142633" stroke="#5d7b86"/><path d="M-88 7v10L11 72 104 17V7L11 62Z" fill="#0c1926"/><path d="M-74 13L10 61 87 17" fill="none" stroke="#72c4b0" stroke-width="2"/>';
  const structures = [
    '<path d="M-58-4v-129L7-97V34Z" fill="#687d87"/><path d="M7 34V-97L65-131V0Z" fill="#354b5b"/><path d="M-58-133L0-167 65-131 7-97Z" fill="#a0adb0" stroke="#c2cccc"/><path d="M-42-115v100M-24-104v101M-7-94v100M24-96v101M43-108v102" stroke="#122a38" stroke-width="7"/><path d="M-42-112v52M24-92v52M43-104v52" stroke="#8ad2c0" stroke-width="3"/><path d="M-12-154v-34L9-176v33" fill="#506875" stroke="#91acae"/><path d="M0-183v-26" stroke="#a6bbba" stroke-width="3"/><circle cy="-210" r="3" fill="#e1b773"/><path d="M-60-44L7-7 67-42" fill="none" stroke="#e5b875" stroke-width="3"/>',
    '<ellipse cy="5" rx="79" ry="43" fill="#1c3341" stroke="#7b939b" stroke-width="3"/><path d="M-77 2C-76-122 77-122 77 2Q0 55-77 2Z" fill="url(#habitat)" stroke="#a5bbc0" stroke-width="3"/><path d="M0-88Q-45-48-40 26M0-88Q45-48 40 26M-72-24Q0 13 72-24" fill="none" stroke="#a5c2c1" stroke-width="2"/><path d="M-18 30V0L4-13 25 0v24Z" fill="#172a37" stroke="#91acae" stroke-width="3"/><path d="M-9 13l15-9 11 6" stroke="#e6bf7b" stroke-width="3" fill="none"/>',
    '<path d="M-65 0v-113L8-72V43Z" fill="#5b7480"/><path d="M8 43V-72L77-111V2Z" fill="#314956"/><path d="M-76-114L-5-155 86-109 9-64Z" fill="#80979e" stroke="#bac6c5"/><path d="M-73-89L8-43 83-86M-73-59L8-13 83-56M-73-29L8 17 83-26" fill="none" stroke="#132d3b" stroke-width="12"/><path d="M-70-87L8-43 80-84M-70-57L8-13 80-54" fill="none" stroke="#91c4b7" stroke-width="3"/><path d="M-21-142v-17l34 18v18Z" fill="#405c6a"/><path d="M-52-106l16 9M-52-76l16 9M-52-46l16 9" stroke="#e3bb79" stroke-width="3"/>',
    '<path d="M-82 5v-62L-35-112 25-82V67Z" fill="#6d7d84"/><path d="M25 67V-82L90-119V30Z" fill="#354a57"/><path d="M-35-112L31-150 90-119 25-82Z" fill="#8d9b9e"/><path d="M-67 13v-61l31-31 43 25v104Z" fill="#122938" stroke="#95a9ac" stroke-width="4"/><path d="M-62-33L1 3M-62-15L1 21M-62 3L1 39" stroke="#45616e" stroke-width="4"/><path d="M-73 8l11 6M-47 23l11 6M-21 38l11 6M39-65l36-21" stroke="#e3b26c" stroke-width="5"/><path d="M46-125v-35" stroke="#9aafb3" stroke-width="3"/>',
    '<path d="M-79 5v-67L-7-102 72-59V9L0 51Z" fill="#405d6a" stroke="#9db2b5"/><path d="M-79-62L-7-102 72-59 0-17Z" fill="#8ca5aa"/><path d="M-57-63L-7-90 50-59 0-30Z" fill="#183b4b" stroke="#92cabb" stroke-width="3"/><path d="M-35-77L19-45M-14-88L40-57" stroke="#709a9d" stroke-width="2"/><path d="M-68-39L-14-8v27L-68-11Z" fill="#183442" stroke="#91b8af"/><path d="M14-8L59-34v26L14 18Z" fill="#193541" stroke="#82b6af"/><path d="M-13-98v-35l30-17 27 15v37L16-82Z" fill="#587682" stroke="#acc0bf"/><ellipse cx="16" cy="-144" rx="28" ry="13" fill="#99b8b8"/><ellipse cx="16" cy="-144" rx="16" ry="7" fill="#163a47"/><path d="M16-152v-30" stroke="#d6bb81" stroke-width="2"/>',
    '<path d="M-49 6v-37L4-62 60-29V8L5 40Z" fill="#657d87" stroke="#acc0bf"/><path d="M-24-22v-131L7-170 39-152V-20L7-2Z" fill="#3a5664" stroke="#9cb5b7" stroke-width="2"/><path d="M-24-152L7-170 39-152 7-133Z" fill="#a7b9b9"/><path d="M-9-39v-94M22-39v-94" stroke="#8bd4bd" stroke-width="4"/><path d="M-39-133L7-160 54-133 7-106Z" fill="#b7c3bc" stroke="#e0ba78" stroke-width="3"/><path d="M7-160v-58" stroke="#9fb9bb" stroke-width="3"/><ellipse cx="7" cy="-185" rx="35" ry="12" fill="none" stroke="#97c6b9" stroke-width="3"/><circle cx="7" cy="-219" r="5" fill="#e7bc75"/><path d="M-35 0L6 24 45 1" fill="none" stroke="#e4b472" stroke-width="3"/>',
  ];
  return shell + structures[index % 6];
}
// `roles` are the figures to draw (at most 3); `countText` is the label («32 roles», or «0 de 32 roles» with filters active).
function building(space, index, roles, countText, onSpace, onRole, selected) {
  const [x, y] = positions[index % 6],
    g = svg("g", {
      transform: `translate(${x} ${y})`,
      class: "building" + (selected === space.id ? " selected" : ""),
      "data-space-id": space.id,
      role: "button",
      tabindex: "0",
      "aria-label": `${space.name}, ${countText}. Entrar`,
    });
  g.innerHTML = architecture(index);
  const label = svg("g", {
    class: "building-label" + (selected === space.id ? " selected" : ""),
    "data-space-id": space.id,
  });
  label.append(
    svg("rect", {
      x: -87,
      y: 75,
      width: 180,
      height: 46,
      rx: 3,
      fill: "#152531",
      stroke: "#4c6875",
    }),
    svg(
      "text",
      { x: 3, y: 94, "text-anchor": "middle", class: "space-name" },
      space.name,
    ),
    svg(
      "text",
      { x: 3, y: 111, "text-anchor": "middle", class: "space-count" },
      `${countText} en resultados`,
    ),
  );
  g.labelOverlay = label;
  const enter = () => onSpace(space.id);
  g.addEventListener("click", enter);
  g.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enter();
    }
  });
  roles.forEach((role, i) => {
    const person = svg("g", {
      transform: `translate(${35 + i * 24} ${41 - i * 9})`,
      class: "agent-person",
      role: "button",
      tabindex: "0",
      "aria-label": `Ver ${role.name}`,
    });
    person.innerHTML =
      '<ellipse cy="12" rx="10" ry="4" fill="#040e18" opacity=".6"/><path d="M-5 3v9M5 3v9" stroke="#8ca3ab" stroke-width="4"/><rect x="-8" y="-15" width="16" height="21" rx="4" fill="#8ca4ab" stroke="#d4dfda"/><rect x="-6" y="-13" width="12" height="7" rx="2" fill="#173341"/><path d="M-4-10h8" stroke="#9cdbc2" stroke-width="2"/><circle cy="-1" r="2" fill="#dfbd7d"/><path d="M-11-6v9M11-6v9" stroke="#6d8791" stroke-width="3"/>';
    person.addEventListener("click", (e) => {
      e.stopPropagation();
      onRole(role.id);
    });
    person.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.stopPropagation();
        e.preventDefault();
        onRole(role.id);
      }
    });
    g.append(person);
  });
  return g;
}
export function renderCity(
  container,
  organization,
  visible,
  { onSpace, onRole, selectedSpace, grouped = true, catalog, filtered = false },
) {
  const root = svg("svg", {
    viewBox: "0 0 1050 730",
    class: "town",
    "aria-label": "Ciudad de agentes. Selecciona un edificio para entrar.",
  });
  root.innerHTML =
    '<defs><linearGradient id="habitat" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8db4b7"/><stop offset=".5" stop-color="#547b8c"/><stop offset="1" stop-color="#263e51"/></linearGradient><pattern id="paper" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#405465" stroke-width=".5" opacity=".4"/><circle cx="0" cy="0" r="1" fill="#77948b" opacity=".4"/></pattern></defs><rect width="1050" height="730" fill="url(#paper)"/>';
  const world = svg("g");
  root.append(world);
  world.innerHTML =
    '<path d="M54 378L537 97 1007 368 523 654Z" fill="#1d303d" stroke="#53707c" stroke-width="2"/><path d="M54 378V403L523 680 1007 395V368L523 654Z" fill="#0b1723" stroke="#344f5d"/><path d="M80 380L526 637M288 242L759 515M526 105L993 375M77 381L557 103M294 505L775 225M519 639L1004 359" fill="none" stroke="#314955" stroke-width="28" stroke-linejoin="round"/><path d="M294 505L775 225M288 242L759 515" fill="none" stroke="#80b7a7" stroke-width="1.6" stroke-dasharray="5 12"/><path d="M65 391L523 658 996 383" fill="none" stroke="#77bea7" stroke-width="2"/><path d="M91 407L191 465M855 461L965 397" stroke="#dcaf6c" stroke-width="4"/><ellipse cx="517" cy="354" rx="52" ry="29" fill="#233b49" stroke="#829d9f" stroke-width="2"/><ellipse cx="517" cy="354" rx="39" ry="21" fill="none" stroke="#bdad7b" stroke-dasharray="6 5"/><path d="M502 351l15-9 16 9-16 9Z" fill="none" stroke="#acc6bc" stroke-width="2"/>';
  [
    [116, 360, 1],
    [170, 298, 0.8],
    [390, 201, 0.9],
    [649, 175, 1],
    [913, 354, 1.05],
    [863, 460, 0.8],
    [642, 590, 0.9],
    [402, 568, 1],
    [174, 446, 0.8],
    [611, 307, 0.65],
    [409, 365, 0.7],
    [698, 465, 0.7],
    [885, 298, 0.65],
  ].forEach((t) => world.append(marker(...t)));
  const labels = svg("g", { class: "map-labels" });
  organization.spaces.forEach((s, i) => {
    const ids = new Set(roleIdsForSpace(organization, s.id)),
      { shown } = buildingRoles(visible, ids, grouped),
      { text } = buildingCounts(catalog ?? visible, visible, ids, grouped, filtered),
      b = building(
        s,
        i,
        shown,
        text,
        onSpace,
        onRole,
        selectedSpace,
      );
    world.append(b);
    const [x, y] = positions[i % 6],
      label = b.labelOverlay;
    label.setAttribute("transform", `translate(${x} ${y})`);
    label.setAttribute("role", "button");
    label.setAttribute("tabindex", "0");
    label.setAttribute("aria-label", `Entrar en ${s.name}, ${text}`);
    label.addEventListener("click", () => onSpace(s.id));
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSpace(s.id);
      }
    });
    labels.append(label);
  });
  world.append(labels);
  world.append(
    svg(
      "text",
      { x: 525, y: 712, "text-anchor": "middle", class: "map-caption" },
      "AGENT CITY / COLONIA LOCAL / SECTOR 01",
    ),
  );
  container.replaceChildren(root);
  let scale = 1,
    dx = 0,
    dy = 0,
    drag = null;
  const paint = () =>
    world.setAttribute(
      "transform",
      `translate(${dx} ${dy}) translate(525 365) scale(${scale}) translate(-525 -365)`,
    );
  root.addEventListener("pointerdown", (e) => {
    if (e.target.closest('[role="button"]')) return;
    drag = { x: e.clientX, y: e.clientY, dx, dy };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const ratio = 1050 / root.getBoundingClientRect().width;
    dx = drag.dx + (e.clientX - drag.x) * ratio;
    dy = drag.dy + (e.clientY - drag.y) * ratio;
    paint();
  });
  root.addEventListener("pointerup", () => (drag = null));
  root.addEventListener("pointercancel", () => (drag = null));
  return {
    zoom(delta) {
      scale = Math.max(0.65, Math.min(2, scale + delta));
      paint();
    },
    pan(x, y) {
      dx += x;
      dy += y;
      paint();
    },
    reset() {
      scale = 1;
      dx = dy = 0;
      paint();
    },
  };
}

// Lights buildings in place (no SVG re-render): data-live + a text badge on the label.
export function applyLive(container, bySpace = {}) {
  if (!container) return;
  const summary = (entry) => {
    const { working, waiting } = entry.states;
    if (working && waiting) return `${entry.count} activas`;
    return waiting ? `${waiting} esperando` : `${working} trabajando`;
  };
  container.querySelectorAll("[data-space-id]").forEach((node) => {
    const entry = bySpace?.[node.dataset.spaceId];
    const isLabel = node.classList.contains("building-label");
    const base = (node.dataset.baseLabel ??= node.getAttribute("aria-label") || "");
    node.querySelector(":scope > .live-badge")?.remove();
    if (!entry || !entry.count) {
      node.removeAttribute("data-live");
      node.setAttribute("aria-label", base);
      return;
    }
    const state = entry.states.working ? "working" : "waiting";
    node.setAttribute("data-live", state);
    node.setAttribute("aria-label", `${base}. ${summary(entry)} en vivo`);
    if (!isLabel) return;
    const text = summary(entry);
    const badge = svg("g", { class: "live-badge", "aria-hidden": "true" });
    badge.append(
      svg("rect", { x: -87, y: 125, width: 180, height: 22, rx: 3 }),
      svg("text", { x: 3, y: 140, "text-anchor": "middle" }, `● ${text}`),
    );
    node.append(badge);
  });
}
