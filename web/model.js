export const normalize = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
export function projectSpaces(org) {
  return org.spaces.filter((space) => space.kind === "context");
}

export function projectsForSpace(org, spaceId) {
  const assignmentProjects = new Set(
    org.assignments
      .filter(
        (assignment) => assignment.spaceId === spaceId && assignment.projectId,
      )
      .map((assignment) => assignment.projectId),
  );
  return org.projects.filter(
    (project) =>
      project.spaceIds.includes(spaceId) || assignmentProjects.has(project.id),
  );
}

export function sourceIssues(roots) {
  return roots.filter(
    (root) => root.status !== "success" || root.diagnostics?.length,
  );
}

export function roleIdsForSpace(org, spaceId) {
  const projects = new Set(
    org.projects.filter((p) => p.spaceIds.includes(spaceId)).map((p) => p.id),
  );
  return [
    ...new Set(
      org.assignments
        .filter((a) => a.spaceId === spaceId || projects.has(a.projectId))
        .map((a) => a.roleId),
    ),
  ];
}
export function filterCatalog(catalog, org, filters = {}) {
  const spaceRoles = filters.space
    ? new Set(roleIdsForSpace(org, filters.space))
    : null;
  const projectRoles = filters.project
    ? new Set(
        org.assignments
          .filter((a) => a.projectId === filters.project)
          .map((a) => a.roleId),
      )
    : null;
  const belongs = (item, roles) =>
    !roles ||
    (item.kind === "role"
      ? roles.has(item.id)
      : org.skillLinks.some(
          (l) => l.skillId === item.id && roles.has(l.roleId),
        ));
  return catalog.filter(
    (item) =>
      (!filters.kind || item.kind === filters.kind) &&
      belongs(item, spaceRoles) &&
      belongs(item, projectRoles) &&
      (!filters.specialty ||
        normalize(item.specialty) === normalize(filters.specialty)) &&
      normalize(
        [
          item.name,
          item.description,
          item.specialty,
          item.source?.relativePath,
        ].join(" "),
      ).includes(normalize(filters.query)),
  );
}
export function selectionState(id, catalog, visible) {
  return !id
    ? "none"
    : !catalog.some((x) => x.id === id)
      ? "missing"
      : !visible.some((x) => x.id === id)
        ? "outside"
        : "visible";
}

export const TRUTH_TIERS = {
  declared: "Declarado",
  static: "Verificado",
  observed: "Probado en ejecución",
};

const hasKeys = (d) => !!d && typeof d === "object" && Object.keys(d).length > 0;
const fact = (tier, value) => ({ tier, ...value });
const invocation = (value, yes, no) =>
  value === true ? yes : value === false ? no : "No declarado";

export function skillCapabilities(item) {
  const d = item?.details;
  const hasDetails = hasKeys(d);
  const header =
    item?.validity === "valid"
      ? fact("static", { text: "Encabezado leído y válido" })
      : null;
  if (!hasDetails) return { hasDetails, header };
  return {
    hasDetails,
    header,
    tools: Array.isArray(d.allowedTools)
      ? fact("declared", { items: d.allowedTools })
      : null,
    user: fact(d.userInvocable == null ? null : "declared", {
      state: d.userInvocable ?? null,
      text: invocation(
        d.userInvocable,
        "El usuario puede invocarla",
        "El usuario no puede invocarla",
      ),
    }),
    model: fact(d.modelInvocable == null ? null : "declared", {
      state: d.modelInvocable ?? null,
      text: invocation(
        d.modelInvocable,
        "El modelo puede invocarla",
        "El modelo no puede invocarla",
      ),
    }),
    version: d.version ? fact("declared", { text: String(d.version) }) : null,
    license: d.license ? fact("declared", { text: String(d.license) }) : null,
    files: Array.isArray(d.files)
      ? fact("declared", {
          items: d.files.map((f) => ({
            name: String(f.name),
            marker: f.kind === "dir" ? "dir" : "file",
          })),
          truncated: d.filesTruncated === true,
        })
      : null,
  };
}

export function roleCapabilities(item) {
  const d = item?.details;
  const hasDetails = hasKeys(d);
  const header =
    item?.validity === "valid"
      ? fact("static", { text: "Encabezado leído y válido" })
      : null;
  if (item?.source?.format === "claude-agents") {
    const model = typeof d?.model === "string" ? d.model.trim() : "";
    return {
      hasDetails,
      header,
      runtime: "claude-code",
      ...(hasDetails && {
        tools: Array.isArray(d.allowedTools)
          ? fact("declared", { items: d.allowedTools })
          : fact("static", {
              text: "No declara herramientas: hereda las de la sesión de Claude Code",
            }),
        model: model
          ? fact("declared", { text: model })
          : fact(null, {
              text: "No declarado: usa el modelo por defecto de la sesión",
            }),
      }),
    };
  }
  return {
    hasDetails,
    header,
    runtime: "codex",
    instructionChars: Number.isInteger(d?.instructionChars)
      ? d.instructionChars
      : null,
    declaresTools: false,
    note: "La definición no declara modelo ni herramientas: el agente las hereda del runtime que lo ejecute.",
  };
}

// ---- Live activity mapping (pure; sessions come from outside, never trusted) ----
const pathKey = (value) => {
  const text = String(value ?? "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .trim();
  return text.length > 1 ? text.replace(/\/+$/, "") : text;
};
export function projectForCwd(org, cwd) {
  const target = pathKey(cwd);
  if (!target) return null;
  let best = null,
    bestLength = 0;
  for (const project of org?.projects ?? []) {
    const base = pathKey(project.path);
    if (!base || base === "/") continue;
    if (
      (target === base || target.startsWith(base + "/")) &&
      base.length > bestLength
    ) {
      best = project;
      bestLength = base.length;
    }
  }
  return best;
}
const knownSpaces = (org, ids) => {
  const valid = new Set((org?.spaces ?? []).map((s) => s.id));
  return [...new Set(ids ?? [])].filter((id) => valid.has(id));
};
function roleSpaceIds(org, roleId) {
  const ids = [];
  for (const a of org?.assignments ?? []) {
    if (a.roleId !== roleId) continue;
    if (a.spaceId) ids.push(a.spaceId);
    if (a.projectId) {
      const project = (org.projects ?? []).find((p) => p.id === a.projectId);
      ids.push(...(project?.spaceIds ?? []));
    }
  }
  return knownSpaces(org, ids);
}
export function liveMapping(live, catalog, org) {
  const out = { bySpace: {}, byRole: {}, unassigned: [], idle: [] };
  const sessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const roles = (catalog ?? []).filter((i) => i.kind === "role");
  const light = (spaceIds, session) => {
    for (const id of spaceIds) {
      const entry = (out.bySpace[id] ??= {
        count: 0,
        states: { working: 0, waiting: 0 },
        sources: [],
        sessions: [],
      });
      entry.count += 1;
      if (session.state === "waiting") entry.states.waiting += 1;
      else entry.states.working += 1;
      if (!entry.sources.includes(session.source))
        entry.sources.push(session.source);
      entry.sessions.push(session);
    }
  };
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    if (!session.active) {
      out.idle.push(session);
      continue;
    }
    const name = normalize(session.agentType);
    if (name) {
      // The same agent name often exists in both runtimes; a session can only be that runtime's role.
      const runtimeFormat = { "claude-code": "claude-agents", codex: "roles" }[
        session.source
      ];
      const matches = roles.filter(
        (r) =>
          normalize(r.name) === name &&
          (!runtimeFormat ||
            !r.source?.format ||
            r.source.format === runtimeFormat),
      );
      if (matches.length > 1) {
        out.unassigned.push({ session, reason: "ambiguous" });
        continue;
      }
      if (matches.length === 1) {
        (out.byRole[matches[0].id] ??= []).push(session);
        const spaceIds = roleSpaceIds(org, matches[0].id);
        if (spaceIds.length) {
          light(spaceIds, session);
          continue;
        }
      }
    }
    const project = projectForCwd(org, session.cwd);
    const spaceIds = project ? knownSpaces(org, project.spaceIds) : [];
    if (spaceIds.length) light(spaceIds, session);
    else out.unassigned.push({ session, reason: "no-match" });
  }
  return out;
}
export const sourceLabel = (source) =>
  source === "claude-code"
    ? "Claude Code"
    : source === "codex"
      ? "Codex"
      : String(source ?? "Desconocido");

// ---- Duplicate grouping (pure). Copies of one logical agent/skill keep their own ids, assignments and links;
// groups are derived in the browser from the catalog and never stored. ----
const WORD_BREAKS = /[^\p{L}\p{N}\p{M}]+/gu; // \p{M}: marks of non-Latin scripts are not separators
const isValid = (item) =>
  !!item && typeof item === "object" && (item.validity == null || item.validity === "valid");
// Same kind + same name once case, accents and separators ("UX Researcher", "ux-researcher") are ignored.
// Invalid items and empty names never merge with anything.
export function groupKey(item) {
  const words = isValid(item) ? normalize(item.name).replace(WORD_BREAKS, " ").trim() : "";
  return words ? `${item.kind}:${words}` : `id:${item?.id}`;
}
const RUNTIME_LABELS = { "claude-agents": "Claude Code", roles: "Codex" };
// Human label of where a copy comes from: the runtime for roles, the connected folder's label otherwise.
export const originLabel = (item, rootLabels) =>
  (item?.kind === "role" && RUNTIME_LABELS[item.source?.format]) ||
  rootLabels?.[item?.source?.rootId] ||
  "Origen desconocido";
// "Same declared metadata" compares the digest of the declared header only, never the file body.
export const sameMetadata = (a, b) => !!a?.digest && a.digest === b?.digest;
export function groupItems(items, rootLabels) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const key = groupKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  return [...byKey].map(([key, variants]) => {
    const valid = variants.filter(isValid);
    const primary =
      valid.find((v) => String(v.description ?? "").trim()) ?? valid[0] ?? variants[0];
    return {
      key,
      kind: primary.kind,
      name: primary.name,
      items: variants,
      primary,
      count: variants.length,
      identical: valid.length < 2 || valid.every((v) => sameMetadata(v, valid[0])),
      origins: [...new Set(variants.map((v) => originLabel(v, rootLabels)))],
    };
  });
}
export const countSummary = (items) => ({
  unique: groupItems(items).length,
  copies: (items ?? []).length,
});
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
export const unitLabel = (kind, n, unique = false) => {
  const one = n === 1,
    skill = kind === "skill",
    noun = skill ? (one ? "skill" : "skills") : one ? "rol" : "roles";
  return unique ? `${noun} ${skill ? (one ? "única" : "únicas") : one ? "único" : "únicos"}` : noun;
};
// «145 roles únicos · 229 copias», or plain «145 roles» when nothing repeats.
export function countLabel(kind, { unique, copies }) {
  const dup = copies > unique;
  return `${fmt(unique)} ${unitLabel(kind, unique, dup)}${dup ? ` · ${fmt(copies)} copias` : ""}`;
}
// Results line: «145 roles únicos (229 copias) · 471 skills únicas (1.647 copias) en resultados».
export function resultsLabel(items, grouped = true) {
  const part = (kind) => {
    const of = (items ?? []).filter((i) => i.kind === kind);
    const unique = grouped ? countSummary(of).unique : of.length;
    return unique < of.length
      ? `${fmt(unique)} ${unitLabel(kind, unique, true)} (${fmt(of.length)} copias)`
      : `${fmt(unique)} ${unitLabel(kind, unique)}`;
  };
  return `${part("role")} · ${part("skill")} en resultados`;
}
export const roleCountLabel = (n) => `${fmt(n)} ${unitLabel("role", n)}`;
// Roles of a building (ids = its role ids): the real total plus at most `limit` figures to draw.
export function buildingRoles(items, ids, grouped = true, limit = 3) {
  const roles = (items ?? []).filter((r) => r.kind === "role" && ids.has(r.id));
  const list = grouped ? groupItems(roles).map((g) => g.primary) : roles;
  return { total: list.length, shown: list.slice(0, limit) };
}
export const stateLabel = (state) =>
  ({ working: "Trabajando", waiting: "Esperando", idle: "En reposo" })[
    state
  ] ?? "Desconocido";
export function elapsedLabel(ageSeconds) {
  const s = Number(ageSeconds);
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 5) return "ahora";
  if (s < 60) return `hace ${Math.floor(s)} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  return `hace ${Math.floor(s / 3600)} h`;
}

// ---- Auto-organize and project detection (pure; the server still validates everything) ----
export const MAX_ROWS = 2000; // per organization collection, as enforced by the store
// Building type -> keyword prefixes. Order is the priority: a specific craft beats a coordinating role.
const SPECIALTY_KEYWORDS = [
  ["studio", ["front", "ui", "ux", "css", "design", "diseno", "visual", "creativ", "brand", "anim", "illustrat", "image", "video"]],
  ["workshop", ["backend", "api", "apis", "database", "sql", "devops", "infra", "secur", "deploy", "docker", "cloud", "server", "sre", "automat"]],
  ["library", ["research", "investig", "docs", "document", "writer", "writing", "redact", "seo", "marketing", "content", "analy", "analisis", "copy", "knowledge", "translat", "trend"]],
  ["control", ["orchestrat", "orquest", "planner", "planning", "architect", "lead", "manag", "coordin", "review", "supervis", "director"]],
];
const DEFAULT_SPECIALTY = "workshop";
const FIELD_LABELS = { name: "el nombre", specialty: "la especialidad", description: "la descripción" };
const tokenMatches = (token, keyword) =>
  token === keyword || (keyword.length > 3 && token.startsWith(keyword));
function classifyRole(role) {
  const fields = {
    name: role.name,
    specialty: role.specialty,
    description: String(role.description ?? "").slice(0, 240),
  };
  for (const [field, text] of Object.entries(fields)) {
    const tokens = normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
    // The building with most matching words wins; ties go to the earlier building in SPECIALTY_KEYWORDS.
    let best = null;
    for (const [type, keywords] of SPECIALTY_KEYWORDS) {
      const hits = tokens.filter((t) => keywords.some((k) => tokenMatches(t, k)));
      if (hits.length > (best?.hits.length ?? 0)) best = { type, hits };
    }
    if (best)
      return { type: best.type, reason: `Palabra clave «${best.hits[0]}» en ${FIELD_LABELS[field]}` };
  }
  return { type: DEFAULT_SPECIALTY, reason: "Sin palabras clave reconocidas: va al Taller por defecto" };
}
// Proposes a building per GROUP of copies (same name), never per copy, so copies never split across buildings.
// Each item: {roleId (representative, also the selection token), roleIds (every unplaced copy that gets assigned),
// spaceId/spaceIds/spaceName, name, count, origins, reason}. Placed copies are never touched: when some copy of a
// group is already in a building, its unplaced siblings follow it there. Skill links are never proposed.
export function proposeOrganization(catalog, organization) {
  const assignments = organization.assignments ?? [];
  const placed = new Set(assignments.map((a) => a.roleId));
  const building = (type) =>
    organization.spaces.find((s) => s.kind === "specialty" && s.type === type);
  const roles = (catalog ?? []).filter((r) => r.kind === "role" && r.validity === "valid");
  const items = [];
  for (const group of groupItems(roles)) {
    const open = group.items.filter((r) => !placed.has(r.id));
    if (!open.length) continue;
    const ids = new Set(group.items.map((r) => r.id));
    const homes = [
      ...new Set(assignments.filter((a) => a.spaceId && ids.has(a.roleId)).map((a) => a.spaceId)),
    ]
      .map((id) => organization.spaces.find((s) => s.id === id))
      .filter(Boolean);
    const base = {
      roleId: open[0].id,
      roleIds: open.map((r) => r.id),
      name: group.name,
      count: open.length,
      origins: [...new Set(open.map((r) => originLabel(r)))],
    };
    if (homes.length) {
      const names = homes.map((s) => s.name).join(", ");
      items.push({
        ...base,
        spaceId: homes[0].id,
        spaceIds: homes.map((s) => s.id),
        spaceName: names,
        reason: `Copia de «${group.name}» ya colocada en ${names}`,
      });
      continue;
    }
    const { type, reason } = classifyRole(group.primary);
    const space = building(type) ?? building(DEFAULT_SPECIALTY);
    if (space)
      items.push({ ...base, spaceId: space.id, spaceIds: [space.id], spaceName: space.name, reason });
  }
  // A group is applied whole or not at all, so the row limit skips the groups that do not fit.
  const room = Math.max(0, MAX_ROWS - assignments.length);
  let used = 0,
    truncated = false;
  const fitting = items.filter((item) => {
    const rows = item.roleIds.length * item.spaceIds.length;
    if (used + rows > room) return (truncated = true), false;
    used += rows;
    return true;
  });
  return { items: fitting, truncated };
}
// selectedIds are item.roleId tokens; each expands to every copy (roleIds) in every target building (spaceIds).
export function applyProposal(organization, proposal, selectedIds) {
  const next = structuredClone(organization);
  const chosen = new Set(selectedIds);
  const known = new Set(next.assignments.map((a) => `${a.roleId}|${a.spaceId ?? ""}|${a.projectId ?? ""}`));
  for (const item of proposal.items) {
    if (!chosen.has(item.roleId)) continue;
    const adds = [];
    for (const spaceId of item.spaceIds ?? [item.spaceId])
      for (const roleId of item.roleIds ?? [item.roleId]) {
        const key = `${roleId}|${spaceId}|`;
        if (!known.has(key)) adds.push([key, { roleId, spaceId }]);
      }
    if (next.assignments.length + adds.length > MAX_ROWS) continue;
    for (const [key, assignment] of adds) {
      known.add(key);
      next.assignments.push(assignment);
    }
  }
  return next;
}
// Which scanned folders ({name, path}) are already projects, by name (accent/case-insensitive) or by folder.
export function projectLookup(organization) {
  const names = new Set(organization.projects.map((p) => normalize(p.name)));
  const paths = new Set(organization.projects.map((p) => pathKey(p.path)).filter(Boolean));
  return {
    has: (folder) => names.has(normalize(folder.name)) || paths.has(pathKey(folder.path)),
    add: (folder) => (names.add(normalize(folder.name)), paths.add(pathKey(folder.path))),
  };
}
// Turns scanned folders into projects of one context, skipping the ones that already exist.
export function addProjectsFromFolders(organization, folders, spaceId, newId) {
  const next = structuredClone(organization);
  const known = projectLookup(next);
  let added = 0;
  for (const folder of folders) {
    const name = String(folder.name).trim().slice(0, 200);
    if (!name || known.has(folder) || next.projects.length >= MAX_ROWS) continue;
    known.add(folder);
    next.projects.push({ id: newId(), name, spaceIds: [spaceId], path: folder.path });
    added += 1;
  }
  return { organization: next, added, skipped: folders.length - added };
}

// Beginner guide ("Empezar aquí"). Pure data so content drift can be unit tested.
export const GUIDE_ACTIONS = ["sources", "project", "city", "list", "hooks"];
export const GUIDE_STEPS = [
  {
    id: "what",
    title: "Qué es Agent City",
    body: [
      "Agent City es un mapa visual de tu equipo de inteligencia artificial. Cada robot es un agente: una definición (un archivo) que dice quién es y en qué es bueno.",
      "La ciudad solo muestra lo que ya tienes en tu ordenador. No cambia tus archivos, no sube nada a internet y todavía no lanza agentes ni les da órdenes.",
    ],
  },
  {
    id: "city",
    title: "La ciudad y los edificios",
    body: [
      "La ciudad es tu organización. Tiene seis edificios, de dos tipos.",
      "Un edificio es solo una forma de mirar la misma información, no una copia. Un agente puede estar en varios edificios a la vez. Haz clic en un edificio para entrar y ver a sus agentes. La vista Lista muestra lo mismo con buscador. Los nombres se pueden cambiar.",
    ],
    bullets: [
      "Oficina y Casa son contextos de trabajo (profesional y personal): ahí viven tus proyectos.",
      "Biblioteca, Taller, Estudio y Torre de control son especialidades: agrupan a los agentes según lo que hacen (conocimiento, desarrollo, creación, seguimiento).",
    ],
  },
  {
    id: "sources",
    title: "Paso 1 · Trae tus agentes y skills",
    body: [
      "Pulsa «Conectar fuentes». Una fuente es una carpeta de tu ordenador.",
      "Un agente (o rol) es una persona virtual con una especialidad. Una skill es una habilidad empaquetada: un conjunto de instrucciones que un agente puede usar, por ejemplo «diseñar una landing».",
      "No se instalan ni se copian. La ciudad solo lee la cabecera de cada archivo para listarlos.",
      "Para cada fuente, elige la sugerencia, comprueba el tipo y pulsa «Autorizar e importar». Si añades skills nuevas a esa carpeta, pulsa actualizar la fuente.",
      "Atajo: «Conectar todo lo encontrado» busca en tu ordenador las carpetas de Claude Code, Codex, plugins y otras herramientas, te las muestra con su recuento y las conecta de una vez cuando lo confirmas.",
    ],
    bullets: [
      "Roles de Codex: archivos .toml, normalmente en tu carpeta .codex\\agents.",
      "Agentes de Claude Code: archivos .md, normalmente en .claude\\agents.",
      "Skills: carpetas con un archivo SKILL.md, normalmente en .agents\\skills.",
    ],
    actions: [{ label: "Abrir Conectar fuentes", action: "sources" }],
  },
  {
    id: "organize",
    title: "Paso 2 · Organiza",
    body: [
      "Crea un proyecto con «Nuevo proyecto» en la barra lateral. La carpeta del proyecto es opcional, pero permite que la actividad en vivo sepa dónde pertenece una sesión.",
      "Abre un agente y usa «Asignar edificio o proyecto» para colocarlo.",
      "Con «Vincular skill» relacionas a mano una skill con un agente. Es tu anotación personal, no una comprobación técnica.",
      "Atajos: «Organizar automáticamente» propone un edificio para cada agente que aún no tiene lugar y explica por qué; tú eliges qué aplicar. «Detectar proyectos» crea proyectos a partir de las subcarpetas de una carpeta, por ejemplo la que agrupa tus proyectos.",
      "«Deshacer» recupera los últimos cambios de organización.",
    ],
    actions: [{ label: "Crear un proyecto", action: "project" }],
  },
  {
    id: "understand",
    title: "Paso 3 · Mira y entiende",
    body: [
      "Haz clic en un agente o una skill para ver su ficha. Cada dato lleva una etiqueta que dice cuánto te puedes fiar de él.",
      "«No declarado» significa que no lo sabemos, no que no pueda hacerlo. Los agentes de Codex no declaran herramientas: las heredan del programa que los ejecuta.",
    ],
    bullets: [
      "Declarado: el archivo lo dice.",
      "Verificado: el archivo es coherente.",
      "Probado en ejecución: se ha visto funcionar. Aún no se produce.",
    ],
    actions: [
      { label: "Ver la ciudad", action: "city" },
      { label: "Ver la lista", action: "list" },
    ],
  },
  {
    id: "live",
    title: "Paso 4 (opcional) · Actividad en vivo",
    body: [
      "Con Claude Code y Codex, la ciudad puede iluminar el edificio de lo que está trabajando ahora mismo.",
      "Se activa con «Conectar hooks»: copias un fragmento de configuración y lo pegas tú. La ciudad nunca toca tus archivos.",
      "Solo se envía el tipo de evento, la carpeta, la herramienta y el nombre del agente, nunca tus conversaciones. Si la ciudad está cerrada no pasa nada.",
    ],
    actions: [{ label: "Conectar hooks", action: "hooks" }],
  },
  {
    id: "limits",
    title: "Qué no hace (todavía)",
    body: [
      "Agent City no lanza ni controla agentes, no sustituye a Claude Code ni a Codex, y no comprueba que una skill funcione de verdad.",
      "Mini glosario:",
    ],
    bullets: [
      "Agente o rol: una persona virtual con una especialidad, definida en un archivo.",
      "Skill: una habilidad empaquetada que un agente puede usar.",
      "Fuente: una carpeta de tu ordenador de la que la ciudad lee agentes o skills.",
      "Edificio: una forma de agrupar agentes en la ciudad, por contexto o por especialidad.",
      "Proyecto: un trabajo concreto al que puedes asignar agentes; puede tener su carpeta.",
      "Hook: un aviso que Claude Code o Codex envían a la ciudad cuando pasa algo, para mostrar la actividad.",
    ],
  },
];
