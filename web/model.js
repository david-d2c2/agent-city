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
// Proposes a specialty building for every valid role that has no assignment yet.
// Existing assignments are never touched and skill links are never proposed (they stay manual).
export function proposeOrganization(catalog, organization) {
  const placed = new Set((organization.assignments ?? []).map((a) => a.roleId));
  const building = (type) =>
    organization.spaces.find((s) => s.kind === "specialty" && s.type === type);
  const items = [];
  for (const role of catalog ?? []) {
    if (role.kind !== "role" || role.validity !== "valid" || placed.has(role.id)) continue;
    const { type, reason } = classifyRole(role);
    const space = building(type) ?? building(DEFAULT_SPECIALTY);
    if (space)
      items.push({ roleId: role.id, name: role.name, spaceId: space.id, spaceName: space.name, reason });
  }
  const room = Math.max(0, MAX_ROWS - organization.assignments.length);
  return { items: items.slice(0, room), truncated: items.length > room };
}
export function applyProposal(organization, proposal, selectedIds) {
  const next = structuredClone(organization);
  const chosen = new Set(selectedIds);
  const known = new Set(next.assignments.map((a) => `${a.roleId}|${a.spaceId ?? ""}|${a.projectId ?? ""}`));
  for (const item of proposal.items) {
    const key = `${item.roleId}|${item.spaceId}|`;
    if (!chosen.has(item.roleId) || known.has(key) || next.assignments.length >= MAX_ROWS) continue;
    known.add(key);
    next.assignments.push({ roleId: item.roleId, spaceId: item.spaceId });
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
