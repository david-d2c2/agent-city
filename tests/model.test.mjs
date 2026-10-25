import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../web/model.js";

test("room projects combine direct context and explicit specialty assignments by identity", () => {
  const org = {
    projects: [
      { id: "p-context", name: "Shared name", spaceIds: ["home"] },
      { id: "p-specialty", name: "Shared name", spaceIds: ["home"] },
      { id: "p-other", name: "Other", spaceIds: ["office"] },
    ],
    assignments: [
      { roleId: "r", spaceId: "workshop", projectId: "p-specialty" },
      { roleId: "r2", spaceId: "workshop", projectId: "p-specialty" },
    ],
  };
  assert.equal(typeof model.projectsForSpace, "function");
  assert.deepEqual(
    model.projectsForSpace(org, "workshop").map((project) => project.id),
    ["p-specialty"],
  );
  assert.deepEqual(
    model.projectsForSpace(org, "home").map((project) => project.id),
    ["p-context", "p-specialty"],
  );
});

test("source issues remain visible for partial, failed and diagnostic imports", () => {
  const roots = [
    { id: "ok", status: "success", diagnostics: [] },
    { id: "partial", status: "partial", diagnostics: ["limit reached"] },
    { id: "failed", status: "failed", diagnostics: [] },
    { id: "warning", status: "success", diagnostics: ["invalid file"] },
  ];
  assert.equal(typeof model.sourceIssues, "function");
  assert.deepEqual(
    model.sourceIssues(roots).map((root) => root.id),
    ["partial", "failed", "warning"],
  );
});
import {
  normalize,
  filterCatalog,
  roleIdsForSpace,
  selectionState,
} from "../web/model.js";

test("project chooser only exposes context spaces while role membership allows specialties", () => {
  const spaces = [
    { id: "office", kind: "context", name: "Oficina" },
    { id: "studio", kind: "specialty", name: "Estudio" },
    { id: "home", kind: "context", name: "Casa" },
  ];
  assert.equal(typeof model.projectSpaces, "function");
  assert.deepEqual(
    model.projectSpaces({ spaces }).map((space) => space.id),
    ["office", "home"],
  );
  assert.deepEqual(
    model.roleIdsForSpace(
      {
        spaces,
        projects: [],
        assignments: [{ roleId: "designer", spaceId: "studio" }],
      },
      "studio",
    ),
    ["designer"],
  );
});
const catalog = [
  {
    id: "a",
    kind: "role",
    name: "Diseño Élite",
    description: "Edición útil",
    specialty: "Diseño",
  },
  {
    id: "b",
    kind: "role",
    name: "Diseño Élite",
    description: "Backend",
    specialty: "Código",
  },
  {
    id: "s",
    kind: "skill",
    name: "Diseño accesible",
    description: "Interfaz",
    specialty: "Diseño",
  },
];
const organization = {
  spaces: [{ id: "office" }],
  projects: [{ id: "p", spaceIds: ["office"] }],
  assignments: [
    { roleId: "a", spaceId: "office", projectId: "p" },
    { roleId: "b", spaceId: "home" },
  ],
  skillLinks: [{ roleId: "a", skillId: "s", origin: "user" }],
};
test("normalizes Spanish accents and case", () =>
  assert.equal(normalize("  DISEÑO Élite "), "diseno elite"));
test("combines query, kind, space, project and specialty preserving source identities", () =>
  assert.deepEqual(
    filterCatalog(catalog, organization, {
      query: "edicion UTIL",
      kind: "role",
      space: "office",
      project: "p",
      specialty: "diseno",
    }).map((x) => x.id),
    ["a"],
  ));
test("space and project include only explicitly linked skills", () =>
  assert.deepEqual(
    filterCatalog(catalog, organization, {
      kind: "skill",
      space: "office",
      project: "p",
    }).map((x) => x.id),
    ["s"],
  ));
test("same names do not merge; unknown filters yield zero", () => {
  assert.equal(
    filterCatalog(catalog, organization, { query: "diseno" }).length,
    3,
  );
  assert.equal(
    filterCatalog(catalog, organization, { space: "absent" }).length,
    0,
  );
});
test("membership includes explicit space and project context without duplication", () =>
  assert.deepEqual(roleIdsForSpace(organization, "office"), ["a"]));
test("hidden selection persists and missing identity is explicit", () => {
  assert.equal(selectionState("b", catalog, [catalog[0]]), "outside");
  assert.equal(selectionState("gone", catalog, []), "missing");
  assert.equal(selectionState(null, catalog, []), "none");
});

test("truth tiers keep observed defined but skills never produce it", () => {
  assert.equal(model.TRUTH_TIERS.declared, "Declarado");
  assert.equal(model.TRUTH_TIERS.static, "Verificado");
  assert.equal(model.TRUTH_TIERS.observed, "Probado en ejecución");
});

test("skillCapabilities distinguishes unknown from false and flags missing details", () => {
  assert.equal(model.skillCapabilities({ validity: "valid" }).hasDetails, false);
  assert.equal(model.skillCapabilities({ details: {} }).hasDetails, false);
  const c = model.skillCapabilities({
    validity: "valid",
    details: {
      allowedTools: ["Read", "Bash"],
      userInvocable: true,
      modelInvocable: null,
      version: "1.2",
      license: "",
      files: [{ name: "a", kind: "dir" }, { name: "b.md", kind: "file" }],
      filesTruncated: true,
    },
  });
  assert.equal(c.hasDetails, true);
  assert.deepEqual(c.tools, { tier: "declared", items: ["Read", "Bash"] });
  assert.equal(c.user.text, "El usuario puede invocarla");
  assert.equal(c.model.text, "No declarado");
  assert.equal(c.model.state, null);
  assert.equal(c.version.text, "1.2");
  assert.equal(c.license, null);
  assert.deepEqual(c.files.items.map((f) => f.marker), ["dir", "file"]);
  assert.equal(c.files.truncated, true);
  assert.equal(c.header.tier, "static");
  const none = model.skillCapabilities({
    validity: "invalid",
    details: { allowedTools: null, userInvocable: false },
  });
  assert.equal(none.tools, null);
  assert.equal(none.user.text, "El usuario no puede invocarla");
  assert.equal(none.header, null);
});

test("roleCapabilities states that tools are inherited from the runtime", () => {
  const r = model.roleCapabilities({
    validity: "valid",
    details: { instructionChars: 420 },
  });
  assert.equal(r.hasDetails, true);
  assert.equal(r.instructionChars, 420);
  assert.equal(r.declaresTools, false);
  assert.match(r.note, /hereda/);
  assert.equal(model.roleCapabilities({}).hasDetails, false);
  assert.equal(model.roleCapabilities({}).instructionChars, null);
});

const claude = (details) => ({
  validity: "valid",
  source: { format: "claude-agents" },
  details,
});

test("claude agent roleCapabilities declares tools and model", () => {
  const c = model.roleCapabilities(
    claude({ allowedTools: ["Read", "Bash"], model: " sonnet " }),
  );
  assert.equal(c.runtime, "claude-code");
  assert.equal(c.header.tier, "static");
  assert.deepEqual(c.tools, { tier: "declared", items: ["Read", "Bash"] });
  assert.deepEqual(c.model, { tier: "declared", text: "sonnet" });
});

test("claude agent: empty tools list is declared, null tools inherit the session", () => {
  const empty = model.roleCapabilities(claude({ allowedTools: [], model: "" }));
  assert.equal(empty.tools.tier, "declared");
  assert.deepEqual(empty.tools.items, []);
  const none = model.roleCapabilities(claude({ allowedTools: null, model: "" }));
  assert.equal(none.tools.tier, "static");
  assert.equal(none.tools.items, undefined);
  assert.match(none.tools.text, /hereda las de la sesión de Claude Code/);
  assert.equal(none.model.tier, null);
  assert.match(none.model.text, /^No declarado: usa el modelo por defecto/);
});

test("claude agent without details reports missing data and never observed", () => {
  const c = model.roleCapabilities({
    validity: "valid",
    source: { format: "claude-agents" },
  });
  assert.equal(c.runtime, "claude-code");
  assert.equal(c.hasDetails, false);
  assert.equal(c.tools, undefined);
  assert.notEqual(c.tools?.tier, "observed");
});

test("codex role capabilities keep the inherited-runtime note", () => {
  const c = model.roleCapabilities({
    validity: "valid",
    source: { format: "roles" },
    details: { instructionChars: 7 },
  });
  assert.equal(c.runtime, "codex");
  assert.equal(c.instructionChars, 7);
  assert.match(c.note, /hereda/);
  assert.equal(c.tools, undefined);
});

const sess = (o) => ({
  key: "k" + Math.random(),
  source: "claude-code",
  sessionId: "s",
  agentType: null,
  cwd: "",
  state: "working",
  active: true,
  tool: null,
  ageSeconds: 3,
  ...o,
});
const liveOrg = {
  spaces: [{ id: "hq" }, { id: "lab" }, { id: "hangar" }],
  projects: [
    { id: "p1", name: "One", spaceIds: ["lab"], path: "C:\\Work\\Proj" },
    { id: "p2", name: "Deep", spaceIds: ["hangar"], path: "c:/work/proj/deep/" },
    { id: "p3", name: "Posix", spaceIds: ["hq"], path: "/home/me/app" },
  ],
  assignments: [
    { roleId: "r-direct", spaceId: "hq" },
    { roleId: "r-proj", projectId: "p1" },
    { roleId: "r-none" },
  ],
};
const liveCatalog = [
  { id: "r-direct", kind: "role", name: "Revisor Ágil" },
  { id: "r-proj", kind: "role", name: "Planner" },
  { id: "r-none", kind: "role", name: "Sin Sitio" },
  { id: "a1", kind: "role", name: "Twin" },
  { id: "a2", kind: "role", name: "twin" },
  { id: "sk", kind: "skill", name: "Skillonly" },
];
const map = (sessions) => model.liveMapping({ sessions }, liveCatalog, liveOrg);

test("role with direct space lights that building, name match is accent/case-insensitive", () => {
  const s = sess({ agentType: "revisor agil" });
  const m = map([s]);
  assert.equal(m.bySpace.hq.count, 1);
  assert.deepEqual(m.byRole["r-direct"], [s]);
  assert.deepEqual(m.unassigned, []);
});

test("role assigned via project lights the project's context spaces", () => {
  const m = map([sess({ agentType: "Planner", state: "waiting" })]);
  assert.equal(m.bySpace.lab.count, 1);
  assert.equal(m.bySpace.lab.states.waiting, 1);
  assert.deepEqual(m.bySpace.lab.sources, ["claude-code"]);
  assert.equal(m.byRole["r-proj"].length, 1);
});

test("role without spaces falls back to cwd; no cwd match is unassigned no-match", () => {
  const m = map([
    sess({ agentType: "Sin Sitio", cwd: "/home/me/app/src" }),
    sess({ agentType: "Sin Sitio", cwd: "/elsewhere" }),
  ]);
  assert.equal(m.bySpace.hq.count, 1);
  assert.equal(m.byRole["r-none"].length, 2);
  assert.equal(m.unassigned.length, 1);
  assert.equal(m.unassigned[0].reason, "no-match");
});

test("ambiguous role names are unassigned and never fall back", () => {
  const m = map([sess({ agentType: "TWIN", cwd: "/home/me/app" })]);
  assert.deepEqual(m.bySpace, {});
  assert.equal(m.unassigned[0].reason, "ambiguous");
});

test("a session only matches roles of its own runtime, so cross-runtime twins are not ambiguous", () => {
  const catalog = [
    { id: "cx", kind: "role", name: "Frontend Developer", source: { format: "roles" } },
    { id: "cc", kind: "role", name: "Frontend Developer", source: { format: "claude-agents" } },
  ];
  const org = { spaces: [{ id: "hq" }, { id: "lab" }], projects: [], assignments: [{ roleId: "cc", spaceId: "hq" }, { roleId: "cx", spaceId: "lab" }] };
  const claude = model.liveMapping({ sessions: [sess({ agentType: "Frontend Developer" })] }, catalog, org);
  assert.deepEqual(Object.keys(claude.bySpace), ["hq"]);
  assert.equal(claude.byRole.cc.length, 1);
  assert.equal(claude.byRole.cx, undefined);
  const codex = model.liveMapping({ sessions: [sess({ source: "codex", agentType: "frontend developer" })] }, catalog, org);
  assert.deepEqual(Object.keys(codex.bySpace), ["lab"]);
  assert.deepEqual(claude.unassigned, []);
});

test("skills never match as roles; unknown agent type uses cwd", () => {
  const m = map([
    sess({ agentType: "skillonly", cwd: "C:\\Work\\Proj\\x" }),
    sess({ agentType: "unknown", cwd: "C:\\Work\\Proj\\x" }),
  ]);
  assert.equal(m.bySpace.lab.count, 2);
  assert.deepEqual(m.byRole, {});
});

test("longest path prefix wins and separators/case are normalized", () => {
  assert.equal(model.projectForCwd(liveOrg, "C:\\WORK\\proj\\Deep\\src").id, "p2");
  assert.equal(model.projectForCwd(liveOrg, "c:/work/proj/other").id, "p1");
  assert.equal(model.projectForCwd(liveOrg, "C:\\Work\\Proj").id, "p1");
});

test("path boundary: /proj must not match /proj-other", () => {
  assert.equal(model.projectForCwd(liveOrg, "/home/me/app-other"), null);
  assert.equal(model.projectForCwd(liveOrg, "C:\\Work\\Proj-other"), null);
  assert.equal(model.projectForCwd(liveOrg, ""), null);
  assert.equal(model.projectForCwd({ projects: [{ path: "/" }] }, "/x"), null);
});

test("idle and inactive sessions never light buildings", () => {
  const m = map([
    sess({ state: "idle", active: false, cwd: "/home/me/app" }),
    sess({ state: "working", active: false, cwd: "/home/me/app" }),
  ]);
  assert.deepEqual(m.bySpace, {});
  assert.equal(m.idle.length, 2);
  assert.deepEqual(m.unassigned, []);
});

test("unknown spaces are never invented", () => {
  const org = {
    ...liveOrg,
    projects: [{ id: "g", spaceIds: ["ghost"], path: "/g" }],
    assignments: [],
  };
  const m = model.liveMapping({ sessions: [sess({ cwd: "/g" })] }, [], org);
  assert.deepEqual(m.bySpace, {});
  assert.equal(m.unassigned[0].reason, "no-match");
});

test("multiple sessions aggregate per building", () => {
  const m = map([
    sess({ cwd: "/home/me/app", source: "codex" }),
    sess({ cwd: "/home/me/app", state: "waiting" }),
  ]);
  assert.equal(m.bySpace.hq.count, 2);
  assert.deepEqual(m.bySpace.hq.states, { working: 1, waiting: 1 });
  assert.deepEqual([...m.bySpace.hq.sources].sort(), ["claude-code", "codex"]);
});

test("empty, absent and malformed snapshots map to nothing", () => {
  for (const live of [null, undefined, {}, { sessions: null }, { sessions: [null, 3] }]) {
    const m = model.liveMapping(live, liveCatalog, liveOrg);
    assert.deepEqual(m, { bySpace: {}, byRole: {}, unassigned: [], idle: [] });
  }
  assert.deepEqual(model.liveMapping(null, undefined, undefined).bySpace, {});
});

test("live labels are Spanish", () => {
  assert.equal(model.sourceLabel("claude-code"), "Claude Code");
  assert.equal(model.sourceLabel("codex"), "Codex");
  assert.equal(model.stateLabel("working"), "Trabajando");
  assert.equal(model.stateLabel("waiting"), "Esperando");
  assert.equal(model.stateLabel("idle"), "En reposo");
  assert.equal(model.elapsedLabel(2), "ahora");
  assert.equal(model.elapsedLabel(42), "hace 42 s");
  assert.equal(model.elapsedLabel(150), "hace 2 min");
  assert.equal(model.elapsedLabel(7300), "hace 2 h");
  assert.equal(model.elapsedLabel(undefined), "—");
});

test("beginner guide content is complete and consistent", () => {
  const steps = model.GUIDE_STEPS;
  assert.deepEqual(
    steps.map((s) => s.id),
    ["what", "city", "sources", "organize", "understand", "live", "limits"],
  );
  for (const s of steps) {
    assert.ok(s.title.trim(), `${s.id} title`);
    assert.ok(s.body.length > 0 && s.body.every((p) => p.trim()), `${s.id} body`);
    for (const a of s.actions ?? []) {
      assert.ok(a.label.trim());
      assert.ok(model.GUIDE_ACTIONS.includes(a.action), `${s.id} action`);
    }
  }
  const text = steps
    .flatMap((s) => [s.title, ...s.body, ...(s.bullets ?? [])])
    .join("\n");
  for (const word of [
    "Oficina", "Casa", "Biblioteca", "Taller", "Estudio", "Torre de control",
    "Roles de Codex", "Agentes de Claude Code", "Skills",
  ])
    assert.ok(text.includes(word), `mentions ${word}`);
});

test("guide source paths keep their backslashes", () => {
  const text = model.GUIDE_STEPS.flatMap((s) => s.bullets ?? []).join("\n");
  for (const path of [".codex\\agents", ".claude\\agents", ".agents\\skills"])
    assert.ok(text.includes(path), path);
});

const spaces = [
  { id: "office", name: "Oficina", type: "office", kind: "context" },
  { id: "home", name: "Casa", type: "home", kind: "context" },
  { id: "library", name: "Biblioteca", type: "library", kind: "specialty" },
  { id: "workshop", name: "Taller", type: "workshop", kind: "specialty" },
  { id: "studio", name: "Estudio", type: "studio", kind: "specialty" },
  { id: "control", name: "Torre de control", type: "control", kind: "specialty" },
];
const roleItem = (id, name, extra = {}) => ({
  id, kind: "role", validity: "valid", name, description: "", specialty: "", ...extra,
});

test("proposeOrganization picks a building by keyword and explains why", () => {
  const catalog = [
    roleItem("a", "Frontend Developer"),
    roleItem("b", "Backend Architect"),
    roleItem("c", "SEO Specialist"),
    roleItem("d", "Software Architect"),
    roleItem("e", "Code Reviewer"),
    roleItem("f", "Ana", { specialty: "Investigación de mercado" }),
    roleItem("g", "Beto", { description: "Diseña interfaces con CSS" }),
    roleItem("h", "Misterio"),
  ];
  const { items, truncated } = model.proposeOrganization(catalog, { spaces, assignments: [] });
  const byId = Object.fromEntries(items.map((i) => [i.roleId, i]));
  assert.equal(truncated, false);
  assert.deepEqual(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => byId[id].spaceId),
    ["studio", "workshop", "library", "control", "control", "library", "studio", "workshop"],
  );
  assert.match(byId.a.reason, /«frontend».*el nombre/);
  assert.match(byId.f.reason, /la especialidad/);
  assert.match(byId.g.reason, /«css».*la descripción/);
  assert.match(byId.h.reason, /por defecto/);
  assert.equal(byId.a.spaceName, "Estudio");
});

test("proposeOrganization lets the most frequent building win inside one field", () => {
  const description = "Plans releases, ships the api, the database and the docker images; mentions design once.";
  const { items } = model.proposeOrganization([roleItem("a", "Ana", { description })], { spaces, assignments: [] });
  assert.equal(items[0].spaceId, "workshop");
  assert.match(items[0].reason, /en la descripción/);
});

test("proposeOrganization never touches placed, invalid or non-role items and never links skills", () => {
  const catalog = [
    roleItem("placed", "Frontend Developer"),
    roleItem("project-only", "Research Analyst"),
    roleItem("broken", "Writer", { validity: "invalid" }),
    roleItem("gone", "Writer", { validity: "missing" }),
    { id: "skill", kind: "skill", validity: "valid", name: "design", description: "", specialty: "" },
    roleItem("free", "Research Analyst"),
  ];
  const organization = {
    spaces,
    assignments: [{ roleId: "placed", spaceId: "control" }, { roleId: "project-only", projectId: "p" }],
    skillLinks: [],
  };
  const before = structuredClone(organization);
  const proposal = model.proposeOrganization(catalog, organization);
  assert.deepEqual(proposal.items.map((i) => i.roleId), ["free"]);
  assert.deepEqual(organization, before);
  assert.equal(proposal.items[0].skillId, undefined);
});

test("proposeOrganization respects the assignment limit and missing buildings", () => {
  const catalog = [roleItem("a", "Designer"), roleItem("b", "Writer"), roleItem("c", "Planner")];
  const crowded = {
    spaces,
    assignments: Array.from({ length: model.MAX_ROWS - 2 }, (_, n) => ({ roleId: `x${n}`, spaceId: "office" })),
  };
  const limited = model.proposeOrganization(catalog, crowded);
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true);
  const noStudio = model.proposeOrganization([roleItem("a", "Designer")], {
    spaces: spaces.filter((s) => s.id !== "studio"),
    assignments: [],
  });
  assert.equal(noStudio.items[0].spaceId, "workshop");
  assert.equal(model.proposeOrganization(catalog, { spaces: spaces.slice(0, 2), assignments: [] }).items.length, 0);
});

test("applyProposal adds only the selected assignments to a copy", () => {
  const organization = {
    revision: 7,
    spaces,
    projects: [],
    assignments: [{ roleId: "a", spaceId: "studio" }],
    skillLinks: [],
  };
  const proposal = {
    items: [
      { roleId: "a", spaceId: "studio" },
      { roleId: "b", spaceId: "library" },
      { roleId: "c", spaceId: "workshop" },
    ],
  };
  const next = model.applyProposal(organization, proposal, ["a", "b"]);
  assert.deepEqual(next.assignments, [
    { roleId: "a", spaceId: "studio" },
    { roleId: "b", spaceId: "library" },
  ]);
  assert.equal(next.revision, 7);
  assert.equal(organization.assignments.length, 1);
  assert.deepEqual(model.applyProposal(organization, proposal, []).assignments, organization.assignments);
  assert.deepEqual(next.skillLinks, []);
});

test("addProjectsFromFolders creates context projects and skips known names and folders", () => {
  const organization = {
    spaces,
    projects: [
      { id: "p1", name: "Acme", spaceIds: ["office"] },
      { id: "p2", name: "Otro", spaceIds: ["home"], path: "C:\\Work\\Projects\\Beta" },
    ],
    assignments: [],
    skillLinks: [],
  };
  const folders = [
    { name: "ACME", path: "C:\\Work\\Projects\\ACME" },
    { name: "Beta", path: "c:/work/projects/beta/" },
    { name: "Gamma", path: "C:\\Work\\Projects\\Gamma" },
    { name: "Ñandú", path: "C:\\Work\\Projects\\Ñandú" },
  ];
  let n = 0;
  const result = model.addProjectsFromFolders(organization, folders, "office", () => `id${++n}`);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.organization.projects.slice(2), [
    { id: "id1", name: "Gamma", spaceIds: ["office"], path: "C:\\Work\\Projects\\Gamma" },
    { id: "id2", name: "Ñandú", spaceIds: ["office"], path: "C:\\Work\\Projects\\Ñandú" },
  ]);
  assert.equal(organization.projects.length, 2);
  const again = model.addProjectsFromFolders(result.organization, folders, "home", () => "x");
  assert.equal(again.added, 0);
});

// ---- Grouping of copies (same kind + normalized name) ----
const copy = (id, name, extra = {}) => ({
  id, kind: "role", validity: "valid", name, description: "", specialty: "", digest: `d-${id}`,
  source: { rootId: "r-codex", relativePath: `${id}.toml`, format: "roles" }, ...extra,
});
const claudeCopy = (id, name, extra = {}) =>
  copy(id, name, { source: { rootId: "r-claude", relativePath: `${id}.md`, format: "claude-agents" }, ...extra });

test("groupKey ignores case, accents and separators but never kind", () => {
  const key = (name, kind = "role") => model.groupKey({ id: "x", kind, name });
  assert.equal(key("UX Researcher"), "role:ux researcher");
  assert.equal(key("ux-researcher"), key("UX Researcher"));
  assert.equal(key("UX_researcher"), key("UX Researcher"));
  assert.equal(key("  ux --  researcher.. "), key("UX Researcher"));
  assert.equal(key("Diseño Élite"), key("DISENO elite"));
  assert.notEqual(key("Design", "role"), key("Design", "skill"));
  assert.notEqual(key("ux researcher"), key("uxresearcher"));
});

test("groupKey keeps non-Latin names apart instead of collapsing them to empty", () => {
  const key = (name) => model.groupKey({ id: "x", kind: "skill", name });
  assert.equal(key("日本語 ツール"), "skill:日本語 ツール");
  assert.notEqual(key("日本語"), key("中文"));
  assert.notEqual(key("Дизайнер"), key("Разработчик"));
  assert.equal(key("Дизайнер-UI"), key("дизайнер ui"));
  assert.equal(key("かな-が"), key("かな が"));
  assert.equal(key("Tool 2"), key("tool-2"));
  assert.notEqual(key("Tool 2"), key("Tool 3"));
});

test("groupKey leaves invalid items and empty names alone", () => {
  assert.equal(model.groupKey({ id: "a", kind: "role", name: "" }), "id:a");
  assert.equal(model.groupKey({ id: "b", kind: "role", name: " -- " }), "id:b");
  assert.equal(model.groupKey({ id: "c", kind: "role", name: "X", validity: "invalid" }), "id:c");
  assert.equal(model.groupKey({ id: "d", kind: "role", name: "X", validity: "missing" }), "id:d");
  assert.equal(model.groupKey(null), "id:undefined");
  const groups = model.groupItems([
    { id: "a", kind: "role", name: "", validity: "invalid" },
    { id: "b", kind: "role", name: "", validity: "invalid" },
  ]);
  assert.equal(groups.length, 2);
});

test("groupItems keeps first-appearance order and original variant order", () => {
  const items = [copy("1", "Beta"), copy("2", "Alpha"), claudeCopy("3", "beta"), copy("4", "ALPHA"), copy("5", "Gamma")];
  const groups = model.groupItems(items);
  assert.deepEqual(groups.map((g) => g.name), ["Beta", "Alpha", "Gamma"]);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [["1", "3"], ["2", "4"], ["5"]]);
  assert.deepEqual(groups.map((g) => g.count), [2, 2, 1]);
  assert.equal(groups[0].kind, "role");
  assert.equal(groups[0].key, "role:beta");
});

test("groupItems picks the first valid variant with a description as primary", () => {
  const noDesc = copy("1", "Dev");
  const described = claudeCopy("2", "dev", { description: "Writes code" });
  const later = copy("3", "DEV", { description: "Other" });
  assert.equal(model.groupItems([noDesc, described, later])[0].primary.id, "2");
  assert.equal(model.groupItems([noDesc, copy("4", "dev")])[0].primary.id, "1");
  assert.equal(model.groupItems([copy("5", "dev", { description: "   " }), described])[0].primary.id, "2");
  assert.equal(model.groupItems([noDesc])[0].primary, noDesc);
});

test("groupItems identical means the same declared-metadata digest on every valid copy", () => {
  const same = model.groupItems([copy("1", "A", { digest: "h" }), claudeCopy("2", "a", { digest: "h" })])[0];
  assert.equal(same.identical, true);
  const different = model.groupItems([copy("1", "A", { digest: "h" }), claudeCopy("2", "a", { digest: "z" })])[0];
  assert.equal(different.identical, false);
  const noDigest = model.groupItems([copy("1", "A", { digest: "" }), claudeCopy("2", "a", { digest: "" })])[0];
  assert.equal(noDigest.identical, false);
  const mixed = model.groupItems([copy("1", "A", { digest: "h" }), claudeCopy("2", "a", { digest: "h" }), copy("3", "a", { digest: "k" })])[0];
  assert.equal(mixed.identical, false);
  assert.equal(model.groupItems([copy("1", "Solo")])[0].identical, true);
  assert.equal(model.sameMetadata(copy("1", "A", { digest: "h" }), copy("2", "A", { digest: "h" })), true);
  assert.equal(model.sameMetadata(copy("1", "A", { digest: "" }), copy("2", "A", { digest: "" })), false);
});

test("groupItems origins are unique human labels: runtime for roles, root label for skills", () => {
  const roles = model.groupItems([copy("1", "A"), claudeCopy("2", "A"), claudeCopy("3", "A", { source: { rootId: "r-plugin", format: "claude-agents" } })])[0];
  assert.deepEqual(roles.origins, ["Codex", "Claude Code"]);
  const skill = (id, rootId) => ({ id, kind: "skill", validity: "valid", name: "Deploy", digest: id, source: { rootId, relativePath: `${id}/SKILL.md`, format: "skills" } });
  const labels = { "r-1": "Claude Code · skills", "r-2": "Codex · skills" };
  const skills = model.groupItems([skill("a", "r-1"), skill("b", "r-2"), skill("c", "r-1")], labels)[0];
  assert.deepEqual(skills.origins, ["Claude Code · skills", "Codex · skills"]);
  assert.deepEqual(model.groupItems([skill("a", "r-9")])[0].origins, ["Origen desconocido"]);
  assert.equal(model.originLabel(copy("1", "A"), labels), "Codex");
});

test("groupItems tolerates empty input and does not mutate it", () => {
  assert.deepEqual(model.groupItems([]), []);
  assert.deepEqual(model.groupItems(undefined), []);
  const items = [copy("1", "A"), claudeCopy("2", "a")];
  const before = structuredClone(items);
  model.groupItems(items);
  assert.deepEqual(items, before);
});

test("countSummary reports unique groups and raw copies", () => {
  assert.deepEqual(model.countSummary([copy("1", "A"), claudeCopy("2", "a"), copy("3", "B")]), { unique: 2, copies: 3 });
  assert.deepEqual(model.countSummary([]), { unique: 0, copies: 0 });
});

test("count labels are honest, singular/plural-correct and Spanish", () => {
  assert.equal(model.countLabel("role", { unique: 145, copies: 229 }), "145 roles únicos · 229 copias");
  assert.equal(model.countLabel("role", { unique: 145, copies: 145 }), "145 roles");
  assert.equal(model.countLabel("role", { unique: 1, copies: 1 }), "1 rol");
  assert.equal(model.countLabel("role", { unique: 1, copies: 2 }), "1 rol único · 2 copias");
  assert.equal(model.countLabel("skill", { unique: 1, copies: 3 }), "1 skill única · 3 copias");
  assert.equal(model.countLabel("skill", { unique: 471, copies: 1647 }), "471 skills únicas · 1.647 copias");
  assert.equal(model.countLabel("skill", { unique: 0, copies: 0 }), "0 skills");
  assert.equal(model.unitLabel("skill", 1), "skill");
  assert.equal(model.unitLabel("role", 2, true), "roles únicos");
});

test("resultsLabel shows unique counts with copies, or the plain flat counts", () => {
  const role = (id, name) => ({ id, kind: "role", validity: "valid", name });
  const skill = (id, name) => ({ id, kind: "skill", validity: "valid", name });
  const items = [role("1", "A"), role("2", "a"), role("3", "B"), skill("4", "S"), skill("5", "s"), skill("6", "S")];
  assert.equal(model.resultsLabel(items), "2 roles únicos (3 copias) · 1 skill única (3 copias) en resultados");
  assert.equal(model.resultsLabel(items, false), "3 roles · 3 skills en resultados");
  assert.equal(model.resultsLabel([role("1", "A"), skill("2", "B")]), "1 rol · 1 skill en resultados");
  assert.equal(model.resultsLabel([]), "0 roles · 0 skills en resultados");
  const many = Array.from({ length: 1647 }, (_, n) => skill(`s${n}`, `skill ${n % 471}`));
  assert.match(model.resultsLabel(many), /471 skills únicas \(1\.647 copias\)/);
});

test("roleCountLabel is singular for one and plural otherwise", () => {
  assert.equal(model.roleCountLabel(1), "1 rol");
  assert.equal(model.roleCountLabel(0), "0 roles");
  assert.equal(model.roleCountLabel(3), "3 roles");
  assert.equal(model.roleCountLabel(65), "65 roles");
  assert.equal(model.roleCountLabel(1200), "1.200 roles");
});

test("buildingRoles reports the real total, not the drawn figures", () => {
  const roles = Array.from({ length: 10 }, (_, n) => copy(`r${n}`, `Role ${n % 5}`));
  roles.push({ id: "s", kind: "skill", name: "Skill", validity: "valid" });
  const ids = new Set([...roles.map((r) => r.id)]);
  const grouped = model.buildingRoles(roles, ids);
  assert.equal(grouped.total, 5);
  assert.equal(grouped.shown.length, 3);
  assert.deepEqual(grouped.shown.map((r) => r.id), ["r0", "r1", "r2"]);
  const flat = model.buildingRoles(roles, ids, false);
  assert.equal(flat.total, 10);
  assert.equal(flat.shown.length, 3);
  assert.equal(model.buildingRoles(roles, new Set(["r0"])).total, 1);
  assert.deepEqual(model.buildingRoles(roles, new Set()), { total: 0, shown: [] });
  assert.equal(model.buildingRoles(roles, ids, true, 10).shown.length, 5);
});

test("filterCatalog still returns flat copies; a group appears when any copy matches", () => {
  const items = [
    copy("1", "Frontend Developer", { description: "UI work" }),
    claudeCopy("2", "Frontend Developer", { description: "Browser work" }),
    copy("3", "Backend"),
  ];
  const org = { spaces: [], projects: [], assignments: [], skillLinks: [] };
  const found = model.filterCatalog(items, org, { query: "browser" });
  assert.deepEqual(found.map((i) => i.id), ["2"]);
  const groups = model.groupItems(found);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary.id, "2");
  assert.equal(model.filterCatalog(items, org, { query: "frontend" }).length, 2);
});

// ---- Auto-organize per group ----
test("proposeOrganization decides once per group from the primary and assigns every copy", () => {
  const catalog = [
    copy("a1", "Ana"),
    claudeCopy("a2", "ana", { description: "Diseña interfaces con CSS" }),
    copy("a3", "ANA"),
    copy("b", "Misterio"),
  ];
  const { items, truncated } = model.proposeOrganization(catalog, { spaces, assignments: [] });
  assert.equal(truncated, false);
  assert.equal(items.length, 2);
  const [fe, mystery] = items;
  // primary = first copy with a description (a2): its CSS description picks Estudio, while a1 alone would default to Taller
  assert.equal(fe.spaceId, "studio");
  assert.deepEqual(fe.roleIds, ["a1", "a2", "a3"]);
  assert.equal(fe.roleId, "a1");
  assert.equal(fe.count, 3);
  assert.deepEqual(fe.origins, ["Codex", "Claude Code"]);
  assert.deepEqual(fe.spaceIds, ["studio"]);
  assert.equal(mystery.count, 1);
});

test("proposeOrganization never splits copies across buildings", () => {
  const catalog = [copy("1", "Designer"), claudeCopy("2", "designer", { specialty: "Backend" }), copy("3", "Designer")];
  const { items } = model.proposeOrganization(catalog, { spaces, assignments: [] });
  assert.equal(items.length, 1);
  const next = model.applyProposal({ spaces, assignments: [], projects: [], skillLinks: [] }, { items }, ["1"]);
  assert.equal(new Set(next.assignments.map((a) => a.spaceId)).size, 1);
  assert.deepEqual(next.assignments.map((a) => a.roleId).sort(), ["1", "2", "3"]);
});

test("proposeOrganization sends siblings of a placed copy to the same building, with a reason", () => {
  const catalog = [copy("1", "Designer"), claudeCopy("2", "designer"), copy("3", "Designer")];
  const organization = { spaces, assignments: [{ roleId: "1", spaceId: "control" }], projects: [], skillLinks: [] };
  const before = structuredClone(organization);
  const { items } = model.proposeOrganization(catalog, organization);
  assert.equal(items.length, 1);
  assert.equal(items[0].spaceId, "control"); // not Studio, which "Designer" would get on its own
  assert.deepEqual(items[0].roleIds, ["2", "3"]);
  assert.equal(items[0].reason, "Copia de «Designer» ya colocada en Torre de control");
  assert.equal(items[0].spaceName, "Torre de control");
  assert.deepEqual(organization, before);
  const next = model.applyProposal(organization, { items }, [items[0].roleId]);
  assert.deepEqual(next.assignments, [
    { roleId: "1", spaceId: "control" },
    { roleId: "2", spaceId: "control" },
    { roleId: "3", spaceId: "control" },
  ]);
});

test("proposeOrganization follows every building of the placed copy and skips fully placed groups", () => {
  const catalog = [copy("1", "Designer"), claudeCopy("2", "designer"), copy("x", "Writer"), claudeCopy("y", "writer")];
  const organization = {
    spaces,
    assignments: [
      { roleId: "1", spaceId: "control" },
      { roleId: "1", spaceId: "library" },
      { roleId: "x", spaceId: "library" },
      { roleId: "y", projectId: "p" },
    ],
  };
  const { items } = model.proposeOrganization(catalog, organization);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].spaceIds, ["control", "library"]);
  assert.equal(items[0].spaceName, "Torre de control, Biblioteca");
  const next = model.applyProposal(organization, { items }, ["2"]);
  assert.equal(next.assignments.length, organization.assignments.length + 2);
});

test("a placed copy with only a project does not decide the building; the group is classified normally", () => {
  const catalog = [copy("1", "Designer"), claudeCopy("2", "designer")];
  const { items } = model.proposeOrganization(catalog, { spaces, assignments: [{ roleId: "1", projectId: "p" }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].spaceId, "studio");
  assert.deepEqual(items[0].roleIds, ["2"]);
  assert.match(items[0].reason, /Palabra clave/);
});

test("proposeOrganization never creates skill links and ignores skills and invalid roles", () => {
  const catalog = [
    copy("1", "Designer"),
    { id: "s", kind: "skill", validity: "valid", name: "Designer" },
    copy("bad", "Designer", { validity: "invalid" }),
  ];
  const { items } = model.proposeOrganization(catalog, { spaces, assignments: [] });
  assert.deepEqual(items.map((i) => i.roleIds), [["1"]]);
  assert.equal(items[0].skillId, undefined);
});

test("proposal row limit is per assignment row and never cuts a group in half", () => {
  const catalog = [copy("a1", "Alpha"), claudeCopy("a2", "alpha"), claudeCopy("a3", "alpha"), copy("b", "Beta")];
  const nearlyFull = {
    spaces,
    assignments: Array.from({ length: model.MAX_ROWS - 2 }, (_, n) => ({ roleId: `x${n}`, spaceId: "office" })),
  };
  const limited = model.proposeOrganization(catalog, nearlyFull);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.items.map((i) => i.roleIds), [["b"]]);
  const exact = model.proposeOrganization(catalog, {
    spaces,
    assignments: Array.from({ length: model.MAX_ROWS - 4 }, (_, n) => ({ roleId: `x${n}`, spaceId: "office" })),
  });
  assert.equal(exact.truncated, false);
  assert.equal(exact.items.length, 2);
  const forced = model.applyProposal(nearlyFull, { items: [{ roleId: "a1", roleIds: ["a1", "a2", "a3"], spaceId: "studio", spaceIds: ["studio"] }] }, ["a1"]);
  assert.equal(forced.assignments.length, nearlyFull.assignments.length);
});

test("applyProposal only expands selected groups and skips copies already placed", () => {
  const organization = { spaces, projects: [], skillLinks: [], assignments: [{ roleId: "a2", spaceId: "studio" }] };
  const proposal = {
    items: [
      { roleId: "a1", roleIds: ["a1", "a2", "a3"], spaceId: "studio", spaceIds: ["studio"] },
      { roleId: "b1", roleIds: ["b1", "b2"], spaceId: "library", spaceIds: ["library"] },
    ],
  };
  const next = model.applyProposal(organization, proposal, ["a1"]);
  assert.deepEqual(next.assignments.map((a) => a.roleId), ["a2", "a1", "a3"]);
  assert.equal(organization.assignments.length, 1);
  assert.deepEqual(model.applyProposal(organization, proposal, ["b2"]).assignments, organization.assignments);
});

// ---- Real usage matching ----
const skillItem = (id, name, extra = {}) => copy(id, name, { kind: "skill", ...extra });
const use = (kind, name, total, extra = {}) => ({ kind, name, total, last7: 0, last30: total, lastAt: "2026-10-01", ...extra });
const usageGroups = () =>
  model.groupItems([
    copy("a1", "Frontend Developer"), claudeCopy("a2", "frontend-developer"), claudeCopy("a3", "executor"),
    skillItem("s1", "frontend-design"), skillItem("s2", "Handoff Save"), skillItem("s3", "executor"),
  ]);

test("matchUsage matches by normalized key: case, accents and separators", () => {
  const groups = model.groupItems([copy("1", "UX Researcher"), skillItem("2", "Diseño Rápido")]);
  const { byKey, unmatched } = model.matchUsage(groups, [use("agent", "ux_researcher", 3), use("skill", "DISENO-rapido", 2)]);
  assert.equal(byKey.get("role:ux researcher").total, 3);
  assert.equal(byKey.get("skill:diseno rapido").total, 2);
  assert.deepEqual(unmatched, []);
});

test("matchUsage never credits a built-in Claude Code subagent to an installed agent that only shares its name", () => {
  const groups = model.groupItems([claudeCopy("p1", "explore"), claudeCopy("p2", "Plan"), claudeCopy("p3", "executor")]);
  const { byKey, unmatched } = model.matchUsage(groups, [
    use("agent", "Explore", 9),
    use("agent", "general-purpose", 5),
    use("agent", "oh-my-claudecode:explore", 2),
    use("agent", "Plan", 1),
    use("agent", "executor", 3),
  ]);
  assert.deepEqual(unmatched.map((u) => u.name), ["Explore", "general-purpose"]);
  assert.equal(byKey.get("role:explore").total, 2);
  assert.equal(byKey.get("role:plan").total, 1);
  assert.equal(byKey.get("role:executor").total, 3);
});

test("matchUsage keeps kinds apart: an agent name never lights a skill and vice versa", () => {
  const groups = usageGroups();
  const { byKey, unmatched } = model.matchUsage(groups, [use("agent", "frontend-design", 4), use("skill", "frontend developer", 5)]);
  assert.equal(byKey.size, 0);
  assert.equal(unmatched.length, 2);
  const only = model.matchUsage(groups, [use("skill", "executor", 7)]);
  assert.deepEqual([...only.byKey.keys()], ["skill:executor"]);
});

test("matchUsage falls back to the part after the last colon and the exact name wins", () => {
  const groups = usageGroups();
  const suffix = model.matchUsage(groups, [use("agent", "oh-my-claudecode:executor", 2), use("skill", "context-handoff:handoff-save", 1)]);
  assert.equal(suffix.byKey.get("role:executor").total, 2);
  assert.equal(suffix.byKey.get("skill:handoff save").total, 1);
  assert.deepEqual(suffix.byKey.get("role:executor").names, ["oh-my-claudecode:executor"]);
  const colon = model.groupItems([skillItem("1", "plugin:skill"), skillItem("2", "skill")]);
  const exact = model.matchUsage(colon, [use("skill", "plugin:skill", 9)]);
  assert.deepEqual([...exact.byKey.keys()], ["skill:plugin skill"]);
  const deep = model.matchUsage(model.groupItems([skillItem("1", "c")]), [use("skill", "a:b:c", 1)]);
  assert.equal(deep.byKey.get("skill:c").total, 1);
  assert.equal(model.matchUsage(model.groupItems([skillItem("1", "a")]), [use("skill", "a:b:c", 1)]).unmatched.length, 1);
});

test("matchUsage sums several recorded names of one group and keeps the latest day", () => {
  const groups = usageGroups();
  const { byKey } = model.matchUsage(groups, [
    use("agent", "executor", 3, { last7: 1, last30: 2, lastAt: "2026-10-03" }),
    use("agent", "oh-my-claudecode:executor", 4, { last7: 2, last30: 4, lastAt: "2026-10-20" }),
    use("agent", "other:executor", 1, { last7: 0, last30: 1, lastAt: "2026-09-01" }),
  ]);
  assert.deepEqual(byKey.get("role:executor"), {
    total: 8, last7: 3, last30: 7, lastAt: "2026-10-20",
    names: ["executor", "oh-my-claudecode:executor", "other:executor"],
  });
});

test("matchUsage lists built-ins and anything missing from the catalog as unmatched", () => {
  const groups = usageGroups();
  const explore = use("agent", "Explore", 12);
  const general = use("agent", "general-purpose", 5);
  const { byKey, unmatched } = model.matchUsage(groups, [explore, use("agent", "frontend-developer", 1), general, use("skill", "nope", 2)]);
  assert.deepEqual(unmatched.map((u) => u.name), ["Explore", "general-purpose", "nope"]);
  assert.equal(unmatched[0], explore);
  assert.equal(byKey.get("role:frontend developer").total, 1);
});

test("matchUsage tolerates empty, null and malformed input", () => {
  assert.equal(model.matchUsage(null, null).byKey.size, 0);
  assert.deepEqual(model.matchUsage([], undefined).unmatched, []);
  const groups = usageGroups();
  const odd = model.matchUsage(groups, [null, {}, { kind: "agent" }, { kind: "tool", name: "x" }, { kind: "agent", name: "  " }, { kind: "agent", name: "plugin:" }, use("agent", "executor", "x")]);
  assert.equal(odd.byKey.get("role:executor").total, 0);
  assert.equal(odd.unmatched.length, 1);
  assert.deepEqual(model.matchUsage(groups, []).unmatched, []);
});

test("usageState words never say that something is not used and always carry the recording start", () => {
  const meta = { since: "2026-10-25", history: null };
  const used = model.usageState({ total: 3, lastAt: "2026-10-21" }, meta);
  assert.equal(used.used, true);
  assert.equal(used.label, "Usado 3 veces · última vez 2026-10-21");
  assert.equal(model.usageState({ total: 1 }, meta).label, "Usado 1 vez");
  assert.equal(model.usageState({ total: 1500, lastAt: "2026-10-21" }, meta).label, "Usado 1.500 veces · última vez 2026-10-21");
  const none = model.usageState(undefined, meta);
  assert.equal(none.used, false);
  assert.equal(none.label, "Sin uso registrado desde 2026-10-25");
  assert.equal(model.usageState({ total: 0 }, meta).label, none.label);
  for (const m of [meta, null, {}, { since: null }]) {
    assert.doesNotMatch(model.usageState(undefined, m).label, /no se usa/i);
    assert.doesNotMatch(model.usageState({ total: 2, lastAt: "2026-10-21" }, m).label, /no se usa/i);
  }
  assert.equal(model.usageState(undefined, null).label, "Aún no hay registro de uso");
  assert.equal(model.usageState(undefined, { since: null }).label, "Aún no hay registro de uso");
});

test("usageSince covers imported history when it starts earlier than the live recording", () => {
  assert.equal(model.usageSince({ since: "2026-10-25", history: { from: "2026-04-26" } }), "2026-04-26");
  assert.equal(model.usageSince({ since: "2026-10-25", history: { from: null } }), "2026-10-25");
  assert.equal(model.usageSince({ since: null, history: { from: "2026-04-26" } }), "2026-04-26");
  assert.equal(model.usageSince(null), null);
  assert.equal(model.usageState(undefined, { since: "2026-10-25", history: { from: "2026-04-26" } }).label, "Sin uso registrado desde 2026-04-26");
});

test("usageHasData is false for an empty record and true for items, a start day or imported history", () => {
  assert.equal(model.usageHasData(null), false);
  assert.equal(model.usageHasData({ since: null, history: { importedAt: null }, items: [] }), false);
  assert.equal(model.usageHasData({ since: "2026-10-25", items: [] }), true);
  assert.equal(model.usageHasData({ items: [use("agent", "x", 1)] }), true);
  assert.equal(model.usageHasData({ items: [], history: { importedAt: "2026-10-25" } }), true);
});

test("usageSummary counts unique groups with and without recorded use, per period", () => {
  const groups = usageGroups();
  const matched = model.matchUsage(groups, [
    use("agent", "executor", 4, { last30: 0 }), use("agent", "frontend developer", 1),
    use("skill", "frontend-design", 2), use("agent", "Explore", 9),
  ]);
  assert.deepEqual(model.usageSummary(groups, matched), { agents: { used: 2, total: 2 }, skills: { used: 1, total: 3 } });
  assert.deepEqual(model.usageSummary(groups, matched, "30"), { agents: { used: 1, total: 2 }, skills: { used: 1, total: 3 } });
  assert.deepEqual(model.usageSummary(groups, null), { agents: { used: 0, total: 2 }, skills: { used: 0, total: 3 } });
  assert.deepEqual(model.usageSummary(null, matched), { agents: { used: 0, total: 0 }, skills: { used: 0, total: 0 } });
});

test("rankUsage orders by count in the period, then latest day, then name, and drops zeros", () => {
  const rows = [
    { name: "b", total: 5, last30: 0, lastAt: "2026-01-01" },
    { name: "c", total: 5, last30: 2, lastAt: "2026-03-01" },
    { name: "a", total: 5, last30: 2, lastAt: "2026-03-01" },
    { name: "d", total: 9, last30: 1, lastAt: "2026-02-01" },
    { name: "z", total: 0, last30: 0 },
  ];
  assert.deepEqual(model.rankUsage(rows).map((r) => r.name), ["d", "a", "c", "b"]);
  assert.deepEqual(model.rankUsage(rows, "30").map((r) => r.name), ["a", "c", "d"]);
  assert.deepEqual(model.rankUsage(null), []);
});

test("filterByUsage is group-level and any unknown mode keeps everything", () => {
  const groups = usageGroups();
  const matched = model.matchUsage(groups, [use("agent", "executor", 4), use("skill", "frontend-design", 1)]);
  const names = (mode) => model.filterByUsage(groups, matched, mode).map((g) => g.key);
  assert.deepEqual(names("with"), ["role:executor", "skill:frontend design"]);
  assert.equal(names("without").length, groups.length - 2);
  assert.equal(names("").length, groups.length);
  assert.equal(names(undefined).length, groups.length);
  assert.equal(names("toString").length, groups.length);
  assert.equal(model.filterByUsage(groups, null, "with").length, 0);
});
