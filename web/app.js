import {
  GUIDE_STEPS,
  TRUTH_TIERS,
  USAGE_FILTERS,
  addProjectsFromFolders,
  applyProposal,
  buildingRoles,
  elapsedLabel,
  filterByUsage,
  filterCatalog,
  groupItems,
  groupKey,
  liveMapping,
  matchUsage,
  originLabel,
  projectLookup,
  projectSpaces,
  projectsForSpace,
  proposeOrganization,
  rankUsage,
  resultsLabel,
  roleCapabilities,
  roleCountLabel,
  roleIdsForSpace,
  sameMetadata,
  selectionState,
  skillCapabilities,
  sourceIssues,
  sourceLabel,
  stateLabel,
  unitLabel,
  usageCount,
  usageHasData,
  usageSince,
  usageState,
  usageSummary,
} from "./model.js";
import { applyLive, renderCity } from "./scene.js";
import { renderCity3D, webglAvailable } from "./city3d.js";
const app = document.querySelector("#app");
let data = null,
  busy = false,
  city,
  fallback3d = false, // set when the 3D scene failed this page load; the toggle then shows 2D
  dialog;
let prefs = {
  view: matchMedia("(max-width:700px)").matches ? "list" : "city",
  filters: {},
  selected: null,
  group: true, // one row/card per logical agent or skill; off lists every copy
};
try {
  const saved = JSON.parse(localStorage.getItem("agent-city-navigation"));
  if (saved && typeof saved === "object")
    prefs = { ...prefs, ...saved, filters: { ...saved.filters } };
} catch {}
if (typeof prefs.render3d !== "boolean") {
  try {
    prefs.render3d = webglAvailable();
  } catch {
    prefs.render3d = false;
  }
}
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c != null)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const button = (text, action, cls = "button") =>
  el("button", { type: "button", class: cls, onclick: action }, text);
const savePrefs = () => {
  try {
    localStorage.setItem("agent-city-navigation", JSON.stringify(prefs));
  } catch {}
};
const org = () => data.organization;
// Real usage (GET /api/usage). null = not loaded or unavailable: the UI says so instead of guessing.
let usage = null,
  usageMemo = null;
// Usage is matched against the groups of the WHOLE catalog (memoized), so filtering the view never turns used items into «unmatched».
const usageMatched = () => {
  if (usageMemo?.catalog !== data.catalog || usageMemo.usage !== usage) {
    const groups = groupItems(data.catalog);
    usageMemo = { catalog: data.catalog, usage, groups, matched: matchUsage(groups, usage?.items) };
  }
  return usageMemo;
};
const usageMode = () => (Object.hasOwn(USAGE_FILTERS, prefs.filters.usage) ? prefs.filters.usage : "");
// Group-level usage filter, applied after the plain filters; ignored (and explained) while there is no usage record.
const visible = () => {
  const items = filterCatalog(data.catalog, org(), prefs.filters);
  return usageMode() && usageHasData(usage)
    ? filterByUsage(groupItems(items), usageMatched().matched, usageMode()).flatMap((g) => g.items)
    : items;
};
// Copies of the same agent/skill are grouped in the browser only; every copy keeps its own id, assignments and links.
const grouping = () => prefs.group !== false;
const rootLabels = () => Object.fromEntries(data.roots.map((r) => [r.id, r.label]));
const groupsOf = (items) =>
  grouping() ? groupItems(items, rootLabels()) : items.map((i) => groupItems([i], rootLabels())[0]);
const originsText = (origins, max = 3) =>
  (origins.length > max ? [...origins.slice(0, max), `+${origins.length - max}`] : origins).join(" · ");
const copyLines = (group) =>
  group.items.map((i) => `${originLabel(i, rootLabels())} · ${i.source?.relativePath ?? ""}`).join("\n");
const copyBadge = (group) =>
  group.count > 1
    ? el("span", { class: "copy-badge" }, `×${group.count}`, el("span", { class: "sr" }, ` ${group.count} copias`))
    : null;
const status = (message) => {
  const n = document.querySelector("#status");
  if (n) n.textContent = message;
};
async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": data.csrfToken,
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error("El servicio no ha devuelto una respuesta válida.");
  }
  if (!response.ok)
    throw Error(
      response.status === 409
        ? "La organización ha cambiado en otra ventana. Actualiza la página antes de volver a guardar."
        : result.error ||
            result.message ||
            `La operación no pudo guardarse (${response.status}).`,
    );
  return result;
}
async function mutate(path, body, method = "POST") {
  if (busy) return false;
  busy = true;
  document.body.classList.add("busy");
  status("Guardando…");
  try {
    data = await api(path, body, method);
    render();
    status("Cambios guardados en este equipo.");
    return true;
  } catch (error) {
    status(error.message);
    const e = dialog?.querySelector(".form-error");
    if (e) e.textContent = error.message;
    return false;
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}
function updateOrganization(change) {
  const next = structuredClone(org());
  change(next);
  return mutate("/api/organization", next, "PUT");
}
function closeDialog(restoreFocus = true) {
  if (dialog) {
    dialog.restoreOpener = restoreFocus !== false;
    if (dialog.open) dialog.close();
  }
}
function showDialog(title, body, wide = false) {
  closeDialog(false);
  dialog?.remove();
  const opener = document.activeElement;
  dialog = el("dialog", {
    class: wide ? "room-dialog" : "form-dialog",
    "aria-labelledby": "dialog-title",
  });
  const header = el(
    "header",
    { class: "dialog-header" },
    el(
      "div",
      {},
      el(
        "p",
        { class: "eyebrow" },
        wide ? "INTERIOR DE LA ESTACIÓN" : "ORGANIZACIÓN LOCAL",
      ),
      el("h2", { id: "dialog-title" }, title),
    ),
    button("Cerrar ×", closeDialog, "button quiet"),
  );
  dialog.append(header, body);
  const currentDialog = dialog;
  currentDialog.restoreOpener = true;
  dialog.addEventListener("close", () => {
    if (!currentDialog.restoreOpener || dialog !== currentDialog) return;
    if (opener?.isConnected) opener.focus();
    else document.querySelector("#search")?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  (dialog.querySelector("input,select,button") || dialog).focus();
  return dialog;
}
function labeled(label, control) {
  return el("label", { class: "field" }, el("span", {}, label), control);
}
function input(name, placeholder = "", value = "") {
  return el("input", {
    name,
    placeholder,
    value,
    required: "",
    autocomplete: "off",
  });
}
function select(name, options, value = "", empty = "Todos") {
  const n = el("select", { name });
  n.append(el("option", { value: "" }, empty));
  for (const o of options)
    n.append(el("option", { value: o.id ?? o.value }, o.name ?? o.label));
  n.value = value;
  return n;
}
function sourceDialog() {
  const path = input("path", "Ruta absoluta de una carpeta local");
  const label = input("label", "Ej. Mis agentes");
  const format = select(
    "format",
    [
      { id: "roles", name: "Roles · archivos TOML" },
      { id: "skills", name: "Skills · carpetas con SKILL.md" },
      { id: "claude-agents", name: "Agentes de Claude Code · archivos .md" },
    ],
    "roles",
  );
  format.querySelector('option[value=""]').remove();
  format.required = true;
  const form = el(
    "form",
    {
      class: "dialog-body",
      onsubmit: async (e) => {
        e.preventDefault();
        const ok = await mutate("/api/roots", {
          path: path.value.trim(),
          label: label.value.trim(),
          format: format.value,
        });
        if (ok) closeDialog();
      },
    },
    el(
      "p",
      {},
      "Importa definiciones de una carpeta que elijas. Los archivos de origen se leen y se mantienen intactos.",
    ),
    labeled("Carpeta autorizada", path),
    el(
      "p",
      { class: "hint" },
      "Rutas habituales: %USERPROFILE%\\.codex\\agents, %USERPROFILE%\\.agents\\skills o %USERPROFILE%\\.codex\\skills. Sustituye %USERPROFILE% por tu carpeta de usuario.",
    ),
    labeled("Nombre de la fuente", label),
    labeled("Contenido", format),
    el("p", { class: "form-error", role: "alert" }),
    el(
      "button",
      { type: "submit", class: "button primary" },
      "Autorizar e importar",
    ),
  );
  if (data.suggestedRoots?.length) {
    const found = data.suggestedRoots.filter((r) => !r.connected);
    const suggestions = el(
      "div",
      { class: "source-suggestions" },
      el(
        "p",
        { class: "hint" },
        found.length
          ? `Se han detectado ${countOf(found.length, "carpeta", "carpetas")} con definiciones en este equipo que aún no están conectadas. Elegir una solo rellena el formulario; la importación requiere tu acción.`
          : "Todo lo detectado en este equipo ya está conectado.",
      ),
      found.length
        ? button(
            "Conectar todo lo encontrado",
            () => bulkDialog(found),
            "button primary",
          )
        : null,
      found.length
        ? el(
            "details",
            {},
            el("summary", {}, `Elegir una a una (${found.length})`),
            ...found.map((r) =>
              button(
                `${r.label} · ${r.count}`,
                () => {
                  path.value = r.path;
                  label.value = r.label;
                  format.value = r.format;
                  path.focus();
                },
                "button",
              ),
            ),
          )
        : null,
    );
    form.insertBefore(suggestions, form.querySelector(".field"));
  }
  const sources = el(
    "section",
    { class: "source-list" },
    el("h3", {}, "Fuentes conectadas"),
  );
  for (const r of data.roots)
    sources.append(
      el(
        "div",
        { class: "source-row" },
        el("strong", {}, r.label),
        el("p", { class: "mono" }, r.path),
        el(
          "p",
          { class: "hint" },
          `${r.status} · ${{ roles: "Roles", "claude-agents": "Agentes de Claude Code" }[r.format] ?? "Skills"}`,
        ),
        ...(r.diagnostics || []).map((d) =>
          el(
            "p",
            { class: "hint" },
            typeof d === "string" ? d : JSON.stringify(d),
          ),
        ),
        button("Actualizar fuente", async () => {
          if (
            await mutate(`/api/roots/${encodeURIComponent(r.id)}/refresh`, {})
          )
            sourceDialog();
        }),
      ),
    );
  form.append(sources);
  showDialog("Conectar fuentes", form);
}
const countOf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const kindCount = (n, format) =>
  format === "skills" ? countOf(n, "skill", "skills") : countOf(n, "agente", "agentes");
// "Select all" checkbox for a list of checkboxes sharing a name; disabled boxes are left alone.
function selectAllBox(form, name, onChange) {
  const box = el("input", { type: "checkbox", checked: "" });
  box.addEventListener("change", () => {
    form
      .querySelectorAll(`[name=${name}]:not(:disabled)`)
      .forEach((c) => (c.checked = box.checked));
    onChange();
  });
  return el("label", { class: "check" }, box, el("strong", {}, "Seleccionar todas"));
}
function bulkDialog(found) {
  const summary = el("p", { class: "hint", role: "status" });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { type: "submit", class: "button primary" });
  const form = el(
    "form",
    {
      class: "dialog-body",
      onsubmit: async (e) => {
        e.preventDefault();
        const roots = chosen().map(({ path, label, format }) => ({ path, label, format }));
        if (!roots.length) {
          error.textContent = "Elige al menos una carpeta.";
          return;
        }
        error.textContent = "Importando… puede tardar unos segundos.";
        if (await mutate("/api/roots/bulk", { roots })) bulkResultDialog(data.results ?? []);
      },
    },
    el(
      "p",
      {},
      "Estas carpetas existen en tu equipo y contienen definiciones. Revisa la lista y confirma: solo se leen las cabeceras de los archivos, no se ejecuta nada ni se modifica ningún archivo.",
    ),
  );
  const chosen = () =>
    [...form.querySelectorAll("[name=root]:checked")].map((c) => found[Number(c.value)]);
  const update = () => {
    const rows = chosen();
    const total = rows.reduce((n, r) => n + r.count, 0);
    summary.textContent = `${countOf(rows.length, "carpeta elegida", "carpetas elegidas")} · ${countOf(total, "definición", "definiciones")} aproximadas.`;
    submit.textContent = rows.length ? `Conectar ${countOf(rows.length, "fuente", "fuentes")}` : "Conectar";
  };
  form.append(
    selectAllBox(form, "root", update),
    el(
      "div",
      { class: "check-list" },
      ...found.map((r, i) =>
        el(
          "label",
          { class: "check" },
          el("input", { type: "checkbox", name: "root", value: String(i), checked: "" }),
          el(
            "div",
            {},
            el("strong", {}, `${r.label} · ${kindCount(r.count, r.format)}`),
            el("div", { class: "mono" }, r.path),
          ),
        ),
      ),
    ),
    summary,
    error,
    el(
      "div",
      { class: "guide-actions" },
      submit,
      button("Cancelar", sourceDialog, "button quiet"),
    ),
  );
  form.addEventListener("change", update);
  update();
  showDialog("Conectar todo lo encontrado", form);
}
function bulkResultDialog(results) {
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  const imported = (skills) =>
    ok.filter((r) => (r.format === "skills") === skills).reduce((n, r) => n + r.imported, 0);
  showDialog(
    "Fuentes conectadas",
    el(
      "div",
      { class: "dialog-body" },
      el(
        "p",
        { role: "status" },
        `Se importaron ${countOf(imported(false), "agente", "agentes")} y ${countOf(imported(true), "skill", "skills")} desde ${countOf(ok.length, "fuente", "fuentes")}.`,
      ),
      skipped.length
        ? el(
            "p",
            { class: "hint" },
            `${countOf(skipped.length, "fuente ya estaba conectada", "fuentes ya estaban conectadas")} y se ha omitido.`,
          )
        : null,
      ...ok
        .filter((r) => r.reason)
        .map((r) => el("p", { class: "hint" }, `${r.label}: ${r.reason}`)),
      failed.length
        ? el(
            "section",
            { class: "source-list" },
            el("h3", {}, `No se pudieron conectar ${failed.length}`),
            ...failed.map((r) =>
              el(
                "div",
                { class: "source-row" },
                el("strong", {}, r.label || "Sin nombre"),
                el("p", { class: "mono" }, r.path ?? ""),
                el("p", { class: "hint" }, r.reason),
              ),
            ),
          )
        : null,
      el(
        "div",
        { class: "guide-actions" },
        button("Organizar automáticamente", organizeDialog, "button primary"),
        button("Cerrar", closeDialog, "button"),
      ),
    ),
  );
}
function organizeDialog() {
  const proposal = proposeOrganization(data.catalog, org());
  if (!proposal.items.length) {
    showDialog(
      "Organizar automáticamente",
      el(
        "div",
        { class: "dialog-body" },
        el(
          "p",
          {},
          data.catalog.some((i) => i.kind === "role" && i.validity === "valid")
            ? "Todos los agentes ya tienen un lugar; no hay nada que proponer."
            : "Aún no hay agentes importados. Conecta fuentes primero.",
        ),
        button("Conectar fuentes", sourceDialog, "button primary"),
      ),
    );
    return;
  }
  const summary = el("p", { class: "hint", role: "status" });
  const submit = el("button", { type: "submit", class: "button primary" });
  const form = el("form", {
    class: "dialog-body",
    onsubmit: async (e) => {
      e.preventDefault();
      const ids = [...form.querySelectorAll("[name=role]:checked")].map((c) => c.value);
      if (!ids.length) return;
      const copies = proposal.items.filter((i) => ids.includes(i.roleId)).reduce((n, i) => n + i.count, 0);
      if (await mutate("/api/organization", applyProposal(org(), proposal, ids), "PUT")) {
        showDialog(
          "Organización aplicada",
          el(
            "div",
            { class: "dialog-body" },
            el(
              "p",
              { role: "status" },
              `Se colocaron ${countOf(ids.length, "agente único", "agentes únicos")} (${countOf(copies, "copia", "copias")}) en sus edificios.`,
            ),
            el("p", { class: "notice" }, "Si no es lo que querías, pulsa «Deshacer» en la cabecera para revertirlo."),
            button("Cerrar", closeDialog, "button primary"),
          ),
        );
        status("Organización aplicada. «Deshacer» la revierte.");
      }
    },
  });
  const update = () => {
    const boxes = [...form.querySelectorAll("[name=role]:checked")],
      n = boxes.length,
      copies = boxes.reduce((sum, c) => sum + Number(c.dataset.copies), 0);
    summary.textContent = `${n} de ${countOf(proposal.items.length, "agente único", "agentes únicos")} elegidos · ${countOf(copies, "copia", "copias")}.`;
    submit.textContent = `Aplicar (${n})`;
    submit.disabled = n === 0;
  };
  form.append(
    el(
      "p",
      {},
      "Propuesta para los agentes que todavía no tienen lugar. Las copias de un mismo agente van juntas al mismo edificio, el que mejor encaja por su nombre, especialidad o descripción; la razón se muestra debajo. Desmarca los que prefieras colocar a mano.",
    ),
    el(
      "p",
      { class: "hint" },
      "No se cambia nada de lo ya colocado y no se crean vínculos con skills: esos siguen siendo manuales. Si una copia ya tiene edificio, sus otras copias se proponen en el mismo.",
    ),
    selectAllBox(form, "role", update),
  );
  for (const space of org().spaces) {
    const items = proposal.items.filter((i) => i.spaceId === space.id);
    if (!items.length) continue;
    const copies = items.reduce((n, i) => n + i.count, 0);
    form.append(
      el(
        "fieldset",
        { class: "check-list" },
        el("legend", {}, `${space.name} (${items.length}${copies > items.length ? ` · ${copies} copias` : ""})`),
        ...items.map((item) =>
          el(
            "label",
            { class: "check" },
            el("input", {
              type: "checkbox",
              name: "role",
              value: item.roleId,
              "data-copies": String(item.count),
              checked: "",
            }),
            el(
              "div",
              {},
              el("strong", {}, item.name),
              item.count > 1
                ? el("span", { class: "copy-badge" }, `×${item.count}`, el("span", { class: "sr" }, ` ${item.count} copias`))
                : null,
              el("div", { class: "hint" }, `${originsText(item.origins)} · ${item.reason}`),
            ),
          ),
        ),
      ),
    );
  }
  if (proposal.truncated)
    form.append(
      el("p", { class: "hint" }, "Se propone solo lo que cabe en el límite de 2.000 asignaciones; aplica y vuelve a abrir esta ayuda para el resto."),
    );
  form.append(
    summary,
    el("div", { class: "guide-actions" }, submit, button("Cancelar", closeDialog, "button quiet")),
  );
  form.addEventListener("change", update);
  update();
  showDialog("Organizar automáticamente", form);
}
function projectScanDialog() {
  const parent = input("path", "Ej. C:\\Proyectos");
  parent.maxLength = 1000;
  const holder = el("div", { class: "dialog-body" });
  const error = el("p", { class: "form-error", role: "alert" });
  const contexts = projectSpaces(org());
  const drawSearch = () =>
    holder.replaceChildren(
      el(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            error.textContent = "";
            try {
              const result = await api("/api/projects/scan", { path: parent.value.trim() });
              drawFolders(result);
            } catch {
              error.textContent =
                "No se pudo leer esa carpeta: comprueba que la ruta existe, es una carpeta y no es un enlace.";
            }
          },
        },
        el(
          "p",
          {},
          "Escribe la carpeta que contiene tus proyectos. Se listan solo sus subcarpetas directas (sin las ocultas ni node_modules); no se lee su contenido.",
        ),
        labeled("Carpeta que contiene los proyectos", parent),
        error,
        el("button", { type: "submit", class: "button primary" }, "Buscar carpetas"),
      ),
    );
  const drawFolders = ({ folders, truncated }) => {
    const lookup = projectLookup(org());
    const space = select("space", contexts, contexts[0]?.id ?? "", "");
    space.querySelector('option[value=""]').remove();
    const summary = el("p", { class: "hint", role: "status" });
    const submit = el("button", { type: "submit", class: "button primary" });
    const form = el("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const chosen = [...form.querySelectorAll("[name=folder]:checked")].map((c) => folders[Number(c.value)]);
        if (!chosen.length) return;
        const result = addProjectsFromFolders(org(), chosen, space.value, () => crypto.randomUUID());
        if (await mutate("/api/organization", result.organization, "PUT")) {
          showDialog(
            "Proyectos creados",
            el(
              "div",
              { class: "dialog-body" },
              el("p", { role: "status" }, `Se crearon ${countOf(result.added, "proyecto", "proyectos")} en ${space.selectedOptions[0].textContent}.`),
              el("p", { class: "notice" }, "Si no es lo que querías, pulsa «Deshacer» en la cabecera para revertirlo."),
              button("Cerrar", closeDialog, "button primary"),
            ),
          );
          status("Proyectos creados. «Deshacer» los revierte.");
        }
      },
    });
    const update = () => {
      const n = form.querySelectorAll("[name=folder]:checked").length;
      summary.textContent = `${countOf(n, "carpeta elegida", "carpetas elegidas")} de ${folders.length}.`;
      submit.textContent = `Crear ${countOf(n, "proyecto", "proyectos")}`;
      submit.disabled = n === 0;
    };
    // Node.append turns null into the text "null", so drop empty slots first.
    form.append(...[
      folders.length
        ? el("p", {}, `Se encontraron ${countOf(folders.length, "carpeta", "carpetas")} en ${parent.value.trim()}. Elige cuáles son proyectos.`)
        : el("p", {}, "No hay subcarpetas visibles en esa carpeta."),
      truncated
        ? el("p", { class: "hint" }, "Hay más carpetas de las que se muestran (límite de 300).")
        : null,
      labeled("Edificio de contexto", space),
      folders.length ? selectAllBox(form, "folder", update) : null,
      el(
        "div",
        { class: "check-list" },
        ...folders.map((folder, i) => {
          const known = lookup.has(folder);
          return el(
            "label",
            { class: "check" },
            el("input", { type: "checkbox", name: "folder", value: String(i), ...(known ? { disabled: "" } : { checked: "" }) }),
            el(
              "div",
              {},
              el("strong", {}, folder.name),
              known ? el("div", { class: "hint" }, "Ya es un proyecto") : null,
            ),
          );
        }),
      ),
      summary,
      el("p", { class: "form-error", role: "alert" }),
      el(
        "div",
        { class: "guide-actions" },
        submit,
        button("Cambiar carpeta", drawSearch, "button quiet"),
      ),
    ].filter(Boolean));
    form.addEventListener("change", update);
    update();
    holder.replaceChildren(form);
    (form.querySelector("input,select") || form).focus();
  };
  drawSearch();
  showDialog("Detectar proyectos", holder);
}
const GUIDE_KEY = "agent-city-guide-seen";
const guideSeen = () => {
  try {
    return localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return false;
  }
};
const markGuideSeen = () => {
  try {
    localStorage.setItem(GUIDE_KEY, "1");
  } catch {}
};
function showView(view) {
  prefs.view = view;
  savePrefs();
  closeDialog();
  renderContent();
}
const GUIDE_ACTIONS = {
  sources: () => sourceDialog(),
  project: () => projectDialog(),
  hooks: () => hooksDialog(),
  city: () => showView("city"),
  list: () => showView("list"),
};
function guideDialog() {
  let index = 0;
  const holder = el("div", { class: "dialog-body guide" });
  const draw = (moveFocus) => {
    const step = GUIDE_STEPS[index],
      last = index === GUIDE_STEPS.length - 1;
    // replaceChildren turns null into the text "null", so drop empty slots first.
    holder.replaceChildren(...[
      el(
        "p",
        { class: "guide-progress" },
        `Paso ${index + 1} de ${GUIDE_STEPS.length}`,
      ),
      el(
        "ol",
        { class: "guide-dots", "aria-label": "Progreso de la guía" },
        ...GUIDE_STEPS.map((s, i) =>
          el(
            "li",
            {
              class: i === index ? "current" : i < index ? "done" : "",
              ...(i === index ? { "aria-current": "step" } : {}),
            },
            el("span", { class: "sr" }, s.title),
          ),
        ),
      ),
      el("h3", { id: "guide-step-heading", tabindex: "-1" }, step.title),
      ...step.body.map((t) => el("p", {}, t)),
      step.bullets?.length
        ? el("ul", { class: "guide-list" }, ...step.bullets.map((t) => el("li", {}, t)))
        : null,
      step.actions?.length
        ? el(
            "div",
            { class: "guide-actions" },
            ...step.actions.map((a) =>
              button(a.label, () => GUIDE_ACTIONS[a.action]?.(), "button primary"),
            ),
          )
        : null,
      el(
        "div",
        { class: "guide-nav" },
        index > 0
          ? button("Anterior", () => { index--; draw(true); }, "button quiet")
          : null,
        last
          ? button("Terminar", closeDialog, "button primary")
          : button("Siguiente", () => { index++; draw(true); }, "button primary"),
      ),
    ].filter(Boolean));
    if (moveFocus) holder.querySelector("#guide-step-heading").focus();
  };
  draw(false);
  const d = showDialog("Empezar aquí", holder, true);
  d.classList.add("guide-dialog");
  const eyebrow = d.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = "GUÍA PARA EMPEZAR";
  d.addEventListener("close", markGuideSeen);
  holder.querySelector("#guide-step-heading").focus();
}
function projectDialog() {
  const name = input("name", "Nombre del proyecto");
  const folder = input("path", "Ej. C:\\Trabajo\\mi-proyecto");
  folder.required = false;
  folder.maxLength = 1000;
  const checks = projectSpaces(org()).map((s) =>
    el(
      "label",
      { class: "check" },
      el("input", { type: "checkbox", name: "space", value: s.id }),
      s.name,
    ),
  );
  const form = el(
    "form",
    {
      class: "dialog-body",
      onsubmit: async (e) => {
        e.preventDefault();
        const spaceIds = [...form.querySelectorAll("[name=space]:checked")].map(
          (c) => c.value,
        );
        const projectPath = folder.value.trim();
        if (
          await updateOrganization((o) =>
            o.projects.push({
              id: crypto.randomUUID(),
              name: name.value.trim(),
              spaceIds,
              ...(projectPath ? { path: projectPath } : {}),
            }),
          )
        )
          closeDialog();
      },
    },
    labeled("Nombre", name),
    labeled("Carpeta del proyecto (opcional)", folder),
    el(
      "p",
      { class: "hint" },
      "Si una sesión de Claude Code o Codex trabaja dentro de esta carpeta, se ilumina el edificio de contexto del proyecto.",
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Edificios de contexto del proyecto"),
      checks,
    ),
    el("p", { class: "form-error", role: "alert" }),
    el("button", { type: "submit", class: "button primary" }, "Crear proyecto"),
  );
  showDialog("Un nuevo proyecto", form);
}
function renameDialog(space) {
  const name = input("name", "Nombre del edificio", space.name);
  const form = el(
    "form",
    {
      class: "dialog-body",
      onsubmit: async (e) => {
        e.preventDefault();
        if (
          await updateOrganization(
            (o) =>
              (o.spaces.find((s) => s.id === space.id).name =
                name.value.trim()),
          )
        ) {
          closeDialog();
          openRoom(space.id);
        }
      },
    },
    labeled("Nombre del edificio", name),
    el("p", { class: "form-error", role: "alert" }),
    el("button", { type: "submit", class: "button primary" }, "Guardar nombre"),
  );
  showDialog("Renombrar edificio", form);
}
function assignmentDialog(role, defaultSpace = "") {
  const space = select("space", org().spaces, defaultSpace, "Sin edificio");
  const project = select("project", org().projects, "", "Sin proyecto");
  const form = el(
    "form",
    {
      class: "dialog-body",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!space.value && !project.value) {
          form.querySelector(".form-error").textContent =
            "Elige un edificio o un proyecto.";
          return;
        }
        if (
          await updateOrganization((o) => {
            if (
              !o.assignments.some(
                (a) =>
                  a.roleId === role.id &&
                  (a.spaceId || "") === space.value &&
                  (a.projectId || "") === project.value,
              )
            )
              o.assignments.push({
                roleId: role.id,
                ...(space.value ? { spaceId: space.value } : {}),
                ...(project.value ? { projectId: project.value } : {}),
              });
          })
        ) {
          closeDialog();
          selectItem(role.id);
        }
      },
    },
    el("p", {}, role.name),
    labeled("Edificio", space),
    labeled("Proyecto", project),
    el("p", { class: "form-error", role: "alert" }),
    el(
      "button",
      { type: "submit", class: "button primary" },
      "Añadir asignación",
    ),
  );
  showDialog("Dar un lugar a este rol", form);
}
function itemRow(group) {
  const item = group.primary,
    row = button(
      "",
      () => selectItem(item.id),
      "inventory-row" + (group.items.some((i) => i.id === prefs.selected) ? " active" : ""),
    );
  if (group.count > 1) row.title = copyLines(group);
  row.appendChild(
    el(
      "span",
      {},
      el(
        "span",
        { class: "item-kind" },
        item.kind === "role" ? "ROL" : "SKILL",
      ),
      el("strong", {}, item.name),
      copyBadge(group),
      usageChip(group.key),
      item.kind === "role"
        ? el("span", { class: "live-slot", "data-live-role": group.items.map((i) => i.id).join(" ") })
        : null,
      el(
        "span",
        { class: "hint" },
        item.specialty || item.description || "Sin descripción",
      ),
      el(
        "span",
        { class: "source-caption" },
        group.count > 1
          ? originsText(group.origins)
          : item.source?.relativePath || "Origen no disponible",
      ),
    ),
  );
  return row;
}
function selectItem(id) {
  prefs.selected = id;
  savePrefs();
  closeDialog(false);
  renderContent();
  document.querySelector("#detail-heading")?.focus();
}
// Decorative identity only (eye and pad colour); it never signals state or activity.
function toneOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 4;
  return h;
}
function openRoom(id) {
  prefs.space = id;
  savePrefs();
  document
    .querySelectorAll("[data-space-id]")
    .forEach((node) =>
      node.classList.toggle("selected", node.dataset.spaceId === id),
    );
  city?.setSelected?.(id);
  const space = org().spaces.find((s) => s.id === id);
  if (!space) return;
  const ids = new Set(roleIdsForSpace(org(), id)),
    items = visible()
      .filter((i) => i.kind === "role" && ids.has(i.id))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
    roleGroups = groupsOf(items);
  const skills = visible().filter(
      (i) =>
        i.kind === "skill" &&
        org().skillLinks.some((l) => l.skillId === i.id && ids.has(l.roleId)),
    ),
    skillGroups = groupsOf(skills);
  const stat = (kind, groups, flat, suffix) =>
    el(
      "span",
      {},
      el("b", {}, String(groups)),
      ` ${unitLabel(kind, groups, flat > groups)}${suffix}`,
      flat > groups ? ` · ${flat} copias` : "",
    );
  const room = el(
    "div",
    { class: "room-body", "data-type": space.type },
    el(
      "div",
      { class: "room-toolbar" },
      el(
        "p",
        { class: "room-stats" },
        stat("role", roleGroups.length, items.length, ""),
        stat("skill", skillGroups.length, skills.length, skillGroups.length === 1 ? " vinculada" : " vinculadas"),
      ),
      button("Renombrar", () => renameDialog(space), "button quiet"),
    ),
  );
  const floor = el("section", {
    class: "room-floor",
    "aria-label": "Sala de agentes",
  });
  if (!roleGroups.length)
    floor.append(
      el(
        "div",
        { class: "room-empty" },
        el("h3", {}, "Aquí comienza algo bueno"),
        el(
          "p",
          {},
          "Este espacio aún no tiene roles que coincidan con tus filtros.",
        ),
        button("Asignar un rol", () => chooseRole(id), "button primary"),
      ),
    );
  for (const group of roleGroups) {
    const item = group.primary,
      card = button("", () => selectItem(item.id), "room-agent");
    card.dataset.tone = String(toneOf(item.name));
    card.title =
      group.count > 1
        ? `${item.name}${item.specialty ? ` · ${item.specialty}` : ""}\n${copyLines(group)}`
        : `${item.name} · ${group.origins[0]}${item.specialty ? ` · ${item.specialty}` : ""}`;
    // Node.append turns null into the text "null", so drop the badge slot of single copies.
    card.append(
      ...[
        el("span", { class: "portrait", "aria-hidden": "true" }, el("i")),
        el("strong", {}, item.name),
        el(
          "span",
          { class: "hint" },
          [originsText(group.origins), item.specialty].filter(Boolean).join(" · "),
        ),
        copyBadge(group),
        el("span", { class: "live-slot", "data-live-role": group.items.map((i) => i.id).join(" ") }),
      ].filter(Boolean),
    );
    floor.append(card);
  }
  room.append(
    floor,
    el(
      "div",
      { class: "room-projects" },
      el(
        "h3",
        {},
        "Proyectos en este edificio",
        el("span", { class: "count" }, String(projectsForSpace(org(), id).length)),
      ),
      el(
        "div",
        { class: "room-project-list", "aria-label": "Proyectos del edificio" },
        ...projectsForSpace(org(), id).map((p) => {
          const link = button(p.name, () => {
            prefs.filters.project = p.id;
            savePrefs();
            closeDialog();
            render();
          });
          link.title = p.name;
          return link;
        }),
      ),
      button("+ Crear proyecto", projectDialog, "button quiet"),
    ),
  );
  if (skillGroups.length)
    room.append(
      el(
        "section",
        { class: "room-skills" },
        el("h3", {}, "Biblioteca vinculada"),
        ...skillGroups.map(itemRow),
      ),
    );
  if (space.type === "library" || org().spaces.indexOf(space) === 2)
    room.append(
      el(
        "section",
        { class: "room-skills" },
        el("h3", {}, "Catálogo de skills"),
        el(
          "p",
          { class: "hint" },
          "Explora todas las skills importadas. Su presencia en el catálogo no implica un vínculo con un rol.",
        ),
        button(
          "Explorar todas las skills",
          () => {
            prefs.view = "list";
            prefs.filters = { kind: "skill" };
            savePrefs();
            closeDialog();
            render();
          },
          "button",
        ),
      ),
    );
  room.append(
    el(
      "p",
      { class: "hint" },
      "Las figuras representan definiciones de roles, no ejecuciones. La actividad en vivo se muestra en el edificio.",
    ),
  );
  showDialog(space.name, room, true);
  refreshRoleChips();
}
function chooseRole(space) {
  const roles = data.catalog.filter((i) => i.kind === "role");
  const search = input("query", "Buscar un rol");
  search.required = false;
  const list = el("div", { class: "picker-list" });
  const draw = () =>
    list.replaceChildren(
      ...roles
        .filter((i) =>
          i.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
        )
        .map((i) =>
          button(i.name, () => assignmentDialog(i, space), "inventory-row"),
        ),
    );
  search.addEventListener("input", draw);
  draw();
  showDialog(
    "Asignar un rol",
    el(
      "div",
      { class: "dialog-body" },
      search,
      roles.length
        ? list
        : el("p", {}, "Conecta una fuente de roles para empezar."),
    ),
  );
}
function skillLinkDialog(role) {
  const search = input("query", "Buscar una skill por nombre");
  search.required = false;
  const list = el("div", { class: "picker-list" });
  const draw = () =>
    list.replaceChildren(
      ...data.catalog
        .filter(
          (i) =>
            i.kind === "skill" &&
            i.name
              .toLocaleLowerCase()
              .includes(search.value.toLocaleLowerCase()),
        )
        .map((i) =>
          button(
            el(
              "span",
              {},
              el("strong", {}, i.name),
              el(
                "span",
                { class: "source-caption" },
                `${data.roots.find((root) => root.id === i.source?.rootId)?.label || i.source?.rootId || "Fuente desconocida"} · ${i.source?.relativePath || "Ruta no disponible"}`,
              ),
            ),
            async () => {
              if (
                await updateOrganization((o) => {
                  if (
                    !o.skillLinks.some(
                      (l) => l.roleId === role.id && l.skillId === i.id,
                    )
                  )
                    o.skillLinks.push({
                      roleId: role.id,
                      skillId: i.id,
                      origin: "user",
                    });
                })
              ) {
                closeDialog();
                selectItem(role.id);
              }
            },
            "inventory-row",
          ),
        ),
    );
  search.addEventListener("input", draw);
  draw();
  showDialog(
    "Vincular una skill manualmente",
    el(
      "div",
      { class: "dialog-body" },
      el(
        "p",
        {},
        "Este vínculo es tu organización personal; no declara capacidades del proveedor.",
      ),
      search,
      list,
    ),
  );
}
const tierBadge = (tier) =>
  tier ? el("span", { class: `tier tier-${tier}` }, TRUTH_TIERS[tier]) : null;
const capRow = (label, tier, ...content) =>
  el(
    "div",
    { class: "cap-row" },
    el("span", { class: "cap-label" }, label),
    el("span", { class: "cap-value" }, ...content),
    tierBadge(tier),
  );
function capabilities(item) {
  const isRole = item.kind === "role";
  const c = isRole ? roleCapabilities(item) : skillCapabilities(item);
  const box = el(
    "section",
    { class: "capabilities", "aria-label": "Capacidades" },
    el("h3", {}, "Capacidades"),
  );
  if (c.header) box.append(capRow("Archivo", c.header.tier, c.header.text));
  if (isRole && c.runtime === "claude-code") {
    if (!c.hasDetails) {
      box.append(
        el(
          "p",
          { class: "hint" },
          "Sin datos detallados: actualiza la fuente para leerlos.",
        ),
      );
      return box;
    }
    box.append(
      capRow(
        "Herramientas",
        c.tools.tier,
        c.tools.items
          ? c.tools.items.length
            ? el(
                "ul",
                { class: "chips" },
                c.tools.items.map((t) => el("li", {}, t)),
              )
            : "Lista vacía declarada"
          : c.tools.text,
      ),
      capRow("Modelo", c.model.tier, c.model.text),
    );
    return box;
  }
  if (isRole) {
    box.append(capRow("Modelo y herramientas", "static", c.note));
    if (c.instructionChars != null)
      box.append(
        capRow(
          "Instrucciones",
          "declared",
          `${c.instructionChars.toLocaleString("es")} caracteres`,
        ),
      );
  }
  if (!c.hasDetails) {
    box.append(
      el(
        "p",
        { class: "hint" },
        "Sin datos detallados: actualiza la fuente para leerlos.",
      ),
    );
    return box;
  }
  if (!isRole) {
    box.append(
      c.tools
        ? capRow(
            "Herramientas",
            c.tools.tier,
            c.tools.items.length
              ? el(
                  "ul",
                  { class: "chips" },
                  c.tools.items.map((t) => el("li", {}, t)),
                )
              : "Lista vacía declarada",
          )
        : capRow("Herramientas", null, "No declarado"),
      capRow("Usuario", c.user.tier, c.user.text),
      capRow("Modelo", c.model.tier, c.model.text),
    );
    if (c.version) box.append(capRow("Versión", c.version.tier, c.version.text));
    if (c.license) box.append(capRow("Licencia", c.license.tier, c.license.text));
    if (c.files)
      box.append(
        capRow(
          "Archivos",
          c.files.tier,
          c.files.items.length
            ? el(
                "ul",
                { class: "files" },
                c.files.items.map((f) =>
                  el(
                    "li",
                    {},
                    el("span", { class: "mono" }, f.name),
                    f.marker === "dir" ? " (carpeta)" : " (archivo)",
                  ),
                ),
                c.files.truncated ? el("li", {}, "… lista truncada") : null,
              )
            : "Sin archivos adicionales",
        ),
      );
  }
  return box;
}
// Every copy of the selected item's group (whole catalog, not only the current results), compared to the primary.
function copiesSection(item) {
  const key = groupKey(item),
    group = groupItems(data.catalog.filter((i) => groupKey(i) === key), rootLabels())[0];
  if (!group || group.count < 2) return null;
  return el(
    "section",
    { class: "copies", "aria-label": `Copias (${group.count})` },
    el("h3", {}, `Copias (${group.count})`),
    el(
      "p",
      { class: "hint" },
      group.identical
        ? "Todas declaran los mismos metadatos."
        : "Los metadatos declarados no coinciden en todas. Se compara la cabecera declarada, no el contenido del archivo.",
    ),
    ...group.items.map((copy) => {
      const current = copy.id === item.id,
        relation =
          copy === group.primary
            ? "principal"
            : sameMetadata(copy, group.primary)
              ? "mismos metadatos declarados"
              : "metadatos distintos";
      const row = button(
        el(
          "span",
          {},
          el(
            "strong",
            {},
            [originLabel(copy, rootLabels()), rootLabels()[copy.source?.rootId]]
              .filter((label, i, all) => label && all.indexOf(label) === i)
              .join(" · "),
          ),
          el("span", { class: "mono source-caption" }, copy.source?.relativePath || "Ruta no disponible"),
          el("span", { class: `copy-relation${relation === "metadatos distintos" ? " differs" : ""}` }, relation),
        ),
        () => selectItem(copy.id),
        "copy-row" + (current ? " active" : ""),
      );
      if (current) row.setAttribute("aria-current", "true");
      return row;
    }),
  );
}
function detail() {
  const container = document.querySelector("#detail");
  container.replaceChildren();
  if (!prefs.selected) {
    container.append(
      el("p", { class: "eyebrow" }, "UN EQUIPO, A TU MANERA"),
      el("h2", {}, "Todo tiene su lugar."),
      el(
        "p",
        {},
        "Entra en un edificio o elige una definición de la lista para conocerla y organizarla.",
      ),
      el("div", { class: "detail-sketch", "aria-hidden": "true" }, "⬡"),
      el(
        "p",
        { class: "runtime-note" },
        "Inventario y organización local. Agent City no lanza agentes: solo muestra la actividad que le envían tus hooks.",
      ),
    );
    return;
  }
  const item = data.catalog.find((i) => i.id === prefs.selected);
  container.append(
    button(
      "← Cerrar detalle",
      () => {
        prefs.selected = null;
        savePrefs();
        renderContent();
      },
      "button quiet",
    ),
  );
  if (!item) {
    container.append(
      el(
        "h2",
        { id: "detail-heading", tabindex: "-1" },
        "Referencia no disponible",
      ),
      el(
        "p",
        {},
        "La identidad guardada ya no está en el catálogo. Puedes limpiar la selección o actualizar su fuente.",
      ),
    );
    return;
  }
  container.append(
    el(
      "p",
      { class: "eyebrow" },
      item.kind === "role" ? "DEFINICIÓN DE ROL" : "DEFINICIÓN DE SKILL",
    ),
    el("h2", { id: "detail-heading", tabindex: "-1" }, item.name),
  );
  if (item.kind === "role")
    container.append(
      el("div", { class: "live-slot", "data-live-role": item.id }),
    );
  if (selectionState(item.id, data.catalog, visible()) === "outside")
    container.append(
      el(
        "p",
        { class: "notice" },
        "Fuera de los resultados actuales. Tu selección se conserva.",
      ),
      button("Limpiar filtros", clearFilters, "button quiet"),
    );
  container.append(
    el(
      "p",
      {},
      item.description || "La fuente no proporciona una descripción.",
    ),
    el(
      "dl",
      {},
      el("dt", {}, "Especialidad"),
      el("dd", {}, item.specialty || "Sin especificar"),
      el("dt", {}, "Estado del archivo"),
      el(
        "dd",
        {},
        {
          valid: "Disponible",
          invalid: "Metadatos no válidos",
          missing: "Ausente en la fuente",
        }[item.validity] || item.validity,
      ),
      el("dt", {}, "Fuente"),
      el(
        "dd",
        { class: "mono" },
        data.roots.find((r) => r.id === item.source?.rootId)?.label ||
          item.source?.rootId ||
          "Desconocida",
      ),
      el("dd", { class: "mono" }, item.source?.relativePath || ""),
    ),
  );
  for (const diagnostic of item.diagnostics || [])
    container.append(
      el(
        "p",
        { class: "notice" },
        typeof diagnostic === "string"
          ? diagnostic
          : JSON.stringify(diagnostic),
      ),
    );
  const copies = copiesSection(item);
  if (copies) container.append(copies);
  const usageBox = usageSection(item);
  if (usageBox) container.append(usageBox);
  container.append(capabilities(item));
  if (item.kind === "role") {
    container.append(
      el("h3", {}, "Sus lugares"),
      button(
        "+ Asignar edificio o proyecto",
        () => assignmentDialog(item),
        "button quiet",
      ),
    );
    org()
      .assignments.filter((a) => a.roleId === item.id)
      .forEach((a) =>
        container.append(
          el(
            "div",
            { class: "assignment-row" },
            el(
              "span",
              {},
              [
                org().spaces.find((s) => s.id === a.spaceId)?.name,
                org().projects.find((p) => p.id === a.projectId)?.name,
              ]
                .filter(Boolean)
                .join(" · ") || "Referencia de asignación conservada",
            ),
            button(
              "Quitar",
              () =>
                updateOrganization(
                  (o) =>
                    (o.assignments = o.assignments.filter(
                      (x) => JSON.stringify(x) !== JSON.stringify(a),
                    )),
                ),
              "button tiny",
            ),
          ),
        ),
      );
    container.append(
      el("h3", {}, "Skills vinculadas"),
      el("p", { class: "hint" }, "Relaciones añadidas manualmente por ti."),
      button("+ Vincular skill", () => skillLinkDialog(item), "button quiet"),
    );
    org()
      .skillLinks.filter((l) => l.roleId === item.id)
      .forEach((l) => {
        const s = data.catalog.find((i) => i.id === l.skillId);
        container.append(
          el(
            "div",
            { class: "assignment-row" },
            button(
              s?.name || "Skill ausente",
              () => selectItem(l.skillId),
              "text-button",
            ),
            button(
              "Quitar",
              () =>
                updateOrganization(
                  (o) =>
                    (o.skillLinks = o.skillLinks.filter(
                      (x) =>
                        !(x.roleId === l.roleId && x.skillId === l.skillId),
                    )),
                ),
              "button tiny",
            ),
          ),
        );
      });
  }
  container.append(
    el(
      "p",
      { class: "runtime-note" },
      "Agent City no lanza agentes. La actividad en vivo aparece solo si has conectado los hooks.",
    ),
  );
  refreshRoleChips();
}
function clearFilters() {
  prefs.filters = {};
  savePrefs();
  render();
}
function renderContent() {
  const results = visible(),
    roles = results.filter((i) => i.kind === "role").length;
  document.querySelector("#result-count").textContent = resultsLabel(results, grouping());
  refreshBadges();
  const chips = document.querySelector("#active-filters");
  chips.replaceChildren();
  for (const [k, v] of Object.entries(prefs.filters))
    if (v)
      chips.append(
        button(
          `${{ query: "Buscar", kind: "Tipo", space: "Edificio", project: "Proyecto", specialty: "Especialidad", usage: "Uso" }[k]}: ${org().spaces.find((s) => s.id === v)?.name || org().projects.find((p) => p.id === v)?.name || USAGE_FILTERS[v] || v} ×`,
          () => {
            delete prefs.filters[k];
            savePrefs();
            render();
          },
          "filter-chip",
        ),
      );
  const mode = usageMode(),
    usageNote = document.querySelector("#usage-note");
  usageNote.textContent = !mode
    ? ""
    : !usageHasData(usage)
      ? "El filtro de uso no se aplica: todavía no hay registro de uso. Se rellena con los hooks de Claude Code o importando tu historial desde «Uso»."
      : mode === "with"
        ? `Solo lo que consta como usado desde ${usageSince(usage)}.`
        : `Sin uso registrado desde ${usageSince(usage)}: no consta que se haya usado en ese tiempo, lo que no equivale a que no se use.`;
  const stage = document.querySelector("#stage");
  city?.dispose?.();
  city = undefined;
  stage.replaceChildren();
  if (prefs.view === "city") {
    let map = el("div", { class: "map" });
    stage.append(map);
    let is3d = false;
    if (prefs.render3d && !fallback3d) {
      map.classList.add("map-3d");
      let failed = false,
        handle;
      try {
        handle = renderCity3D(
          map,
          org(),
          results,
          {
            onSpace: openRoom,
            onRole: selectItem,
            selectedSpace: prefs.space,
            grouped: grouping(),
            onFallback: () => {
              // May fire during creation or later (context lost): never loop retries.
              failed = true;
              if (handle && city === handle) {
                fallback3d = true;
                renderContent();
              }
            },
          },
          { bySpace: liveMap.bySpace, byRole: liveMap.byRole },
        );
        if (failed) {
          handle?.dispose?.();
          throw new Error("fallback");
        }
        city = handle;
        is3d = true;
      } catch {
        fallback3d = true;
        city = undefined;
        map.replaceWith((map = el("div", { class: "map" })));
      }
    }
    if (!is3d) {
      try {
        city = renderCity(map, org(), results, {
          onSpace: openRoom,
          onRole: selectItem,
          selectedSpace: prefs.space,
          grouped: grouping(),
        });
      } catch {
        stage.replaceChildren(
          el(
            "p",
            {},
            "La escena no pudo dibujarse. Puedes acceder a todo desde la lista.",
          ),
          button("Abrir lista", () => {
            prefs.view = "list";
            render();
          }),
        );
      }
    }
    const toggle3d = el(
      "button",
      {
        type: "button",
        class: "button map-toggle-3d",
        "aria-pressed": String(is3d),
        "aria-label": is3d ? "Vista 3D activa; cambiar a vista 2D" : "Vista 2D activa; cambiar a vista 3D",
        title: is3d ? "Vista 3D" : "Vista 2D",
        onclick: () => {
          prefs.render3d = !is3d;
          fallback3d = false;
          savePrefs();
          renderContent();
          document.querySelector(".map-toggle-3d")?.focus();
        },
      },
      is3d ? "3D" : "2D",
    );
    const controls = el(
      "div",
      { class: "map-controls" },
      button("−", () => city?.zoom(-0.15)),
      button("+", () => city?.zoom(0.15)),
      button("Centrar", () => city?.reset()),
      button("←", () => city?.pan(40, 0)),
      button("→", () => city?.pan(-40, 0)),
      button("↑", () => city?.pan(0, 40)),
      button("↓", () => city?.pan(0, -40)),
      toggle3d,
    );
    [
      "Alejar",
      "Acercar",
      "Centrar mapa",
      "Mover a la izquierda",
      "Mover a la derecha",
      "Mover arriba",
      "Mover abajo",
    ].forEach((label, i) =>
      controls.children[i].setAttribute("aria-label", label),
    );
    controls.setAttribute("aria-label", "Controles del mapa");
    stage.append(
      controls,
      el(
        "p",
        { class: "map-tip" },
        is3d
          ? "Arrastra para mover · Hasta 3 figuras por edificio · Entra para ver todos"
          : "Hasta 3 figuras por edificio · Entra para ver todos",
      ),
    );
    if (!data.catalog.length)
      stage.append(
        el(
          "div",
          { class: "onboarding" },
          el("span", { class: "eyebrow" }, "ESTACIÓN PREPARADA"),
          el("h2", {}, "Ahora, dale vida con tu equipo."),
          el(
            "p",
            {},
            "Conecta tus archivos locales de agentes y skills. Tú eliges qué fuentes importar.",
          ),
          button("Conectar fuentes", sourceDialog, "button primary"),
          button("Cómo funciona esto", guideDialog, "button quiet"),
        ),
      );
    else if (!results.length)
      stage.append(
        el(
          "div",
          { class: "onboarding compact" },
          el("h2", {}, "No hay coincidencias"),
          button("Limpiar filtros", clearFilters),
        ),
      );
    else {
      const located = new Set(
          org().spaces.flatMap((s) => roleIdsForSpace(org(), s.id)),
        ),
        unassigned = groupsOf(
          results.filter((i) => i.kind === "role" && !located.has(i.id)),
        ).length;
      if (unassigned || roles === 0)
        stage.append(
          el(
            "div",
            { class: "onboarding compact" },
            el(
              "h2",
              {},
              unassigned
                ? unassigned === 1
                  ? "1 rol busca su lugar"
                  : `${unassigned} roles buscan su lugar`
                : "Tu biblioteca ya está aquí",
            ),
            el(
              "p",
              {},
              unassigned
                ? "Asigna tus roles a edificios para encontrarlos en la ciudad."
                : "Encuentra todas las skills importadas en la lista.",
            ),
            unassigned
              ? button(
                  "Organizar roles",
                  () => chooseRole(""),
                  "button primary",
                )
              : null,
            button(
              "Abrir lista",
              () => {
                prefs.view = "list";
                savePrefs();
                renderContent();
              },
              "button quiet",
            ),
          ),
        );
    }
  } else {
    const list = el("div", { class: "inventory-list" });
    if (!results.length)
      list.append(
        el(
          "h2",
          {},
          data.catalog.length
            ? "No hay coincidencias"
            : "Tu inventario empieza aquí",
        ),
        el(
          "p",
          {},
          data.catalog.length
            ? "Prueba otra búsqueda o limpia los filtros."
            : "Conecta una carpeta de roles o skills para explorar tus propias definiciones.",
        ),
        button(
          data.catalog.length ? "Limpiar filtros" : "Conectar fuentes",
          data.catalog.length ? clearFilters : sourceDialog,
          "button primary",
        ),
        data.catalog.length
          ? null
          : button("Cómo funciona esto", guideDialog, "button quiet"),
      );
    else for (const group of groupsOf(results)) list.append(itemRow(group));
    stage.append(list);
  }
  const onboarding = stage.querySelector(".onboarding");
  detail();
  if (onboarding) {
    const panel = document.querySelector("#detail");
    if (!prefs.selected) panel.replaceChildren(onboarding);
    else panel.prepend(onboarding);
    panel.classList.add("has-onboarding");
  } else document.querySelector("#detail").classList.remove("has-onboarding");
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.view === prefs.view)),
    );
  sceneSignature = null;
  refreshLive();
}
// Sidebar badges: roles per building, unique when copies are grouped (copies in the tooltip).
function refreshBadges() {
  const byId = new Map(data.catalog.map((i) => [i.id, i]));
  document.querySelectorAll("[data-badge-space]").forEach((node) => {
    const ids = roleIdsForSpace(org(), node.dataset.badgeSpace),
      unique = grouping() ? groupItems(ids.map((id) => byId.get(id) ?? { id })).length : ids.length;
    node.textContent = String(unique);
    node.title = unique < ids.length ? `${unique} ${unitLabel("role", unique, true)} · ${ids.length} copias` : roleCountLabel(unique);
  });
}
function render() {
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el("p", { class: "eyebrow" }, "SECTORES DE LA COLONIA"),
    el(
      "nav",
      { "aria-label": "Edificios" },
      ...org().spaces.map(
        (s, i) =>
          button("", () => openRoom(s.id), "space-link").appendChild(
            el(
              "span",
              {},
              el(
                "span",
                { class: "space-symbol", "aria-hidden": "true" },
                ["⌂", "⌂", "▤", "⚒", "✧", "◷"][i % 6],
              ),
              el("span", {}, s.name),
              el("span", { class: "space-badge", "data-badge-space": s.id }),
            ),
          ).parentElement,
      ),
    ),
    el(
      "div",
      { class: "sidebar-projects" },
      el("p", { class: "eyebrow" }, "PROYECTOS"),
      el(
        "div",
        { class: "project-scroll", "aria-label": "Lista de proyectos" },
        ...org().projects.map((p) => {
          const link = button(
            p.name,
            () => {
              prefs.filters.project = p.id;
              savePrefs();
              render();
            },
            "project-link",
          );
          link.title = p.name;
          return link;
        }),
      ),
      button("+ Nuevo proyecto", projectDialog, "button quiet"),
      button("Detectar proyectos", projectScanDialog, "button quiet"),
      button("Organizar automáticamente", organizeDialog, "button quiet"),
    ),
    el(
      "div",
      { class: "sidebar-bottom" },
      el("span", { class: "local-dot" }, " En este equipo"),
      el("p", { class: "hint" }, "Tus fuentes. Tu organización."),
    ),
  );
  const search = el("input", {
    id: "search",
    type: "search",
    placeholder: "Buscar en tu equipo…",
    "aria-label": "Buscar roles y skills",
    value: prefs.filters.query || "",
  });
  search.addEventListener("input", () => {
    prefs.filters.query = search.value;
    savePrefs();
    renderContent();
  });
  const filters = el("div", { class: "filter-row" }, search);
  for (const [key, label, options] of [
    [
      "kind",
      "Tipo",
      [
        { id: "role", name: "Roles" },
        { id: "skill", name: "Skills" },
      ],
    ],
    ["space", "Edificio", org().spaces],
    ["project", "Proyecto", org().projects],
    [
      "specialty",
      "Especialidad",
      [...new Set(data.catalog.map((i) => i.specialty).filter(Boolean))]
        .sort()
        .map((s) => ({ id: s, name: s })),
    ],
    ["usage", "Uso: todos", Object.entries(USAGE_FILTERS).map(([id, name]) => ({ id, name }))],
  ]) {
    const control = select(key, options, prefs.filters[key] || "", label);
    control.setAttribute("aria-label", key === "usage" ? "Uso" : label);
    control.addEventListener("change", () => {
      prefs.filters[key] = control.value;
      savePrefs();
      renderContent();
    });
    filters.append(control);
  }
  const viewToggle = el("div", { class: "view-toggle", "aria-label": "Vista" });
  for (const [key, label] of [
    ["city", "◈ Ciudad"],
    ["list", "☷ Lista"],
  ]) {
    const b = button(
      label,
      () => {
        prefs.view = key;
        savePrefs();
        renderContent();
      },
      "button",
    );
    b.dataset.view = key;
    viewToggle.append(b);
  }
  app.replaceChildren(
    el(
      "header",
      { class: "topbar" },
      el(
        "a",
        { href: "/", class: "brand" },
        el("span", { class: "brand-mark", "aria-hidden": "true" }, "⬡"),
        el(
          "span",
          {},
          "Agent City",
          el("small", {}, "TU EQUIPO / TU UNIVERSO"),
        ),
      ),
      el(
        "div",
        { class: "top-actions" },
        el("span", { class: "local-pill" }, "● Local y privado"),
        button(
          "Deshacer",
          () => mutate("/api/organization/undo", {}),
          "button quiet",
        ),
        button("Empezar aquí", guideDialog, "button"),
        button("Uso", usageDialog, "button"),
        button("Conectar fuentes", sourceDialog, "button primary"),
      ),
    ),
    el(
      "div",
      { class: "shell" },
      sidebar,
      el(
        "main",
        { class: "workspace" },
        el(
          "header",
          { class: "workspace-heading" },
          el(
            "div",
            {},
            el(
              "p",
              { class: "eyebrow" },
              "ESTACIÓN DE TRABAJO LOCAL / SECTOR 01",
            ),
            el("h1", {}, "Tu equipo, en otra órbita."),
          ),
          viewToggle,
        ),
        filters,
        el("div", { id: "active-filters", class: "active-filters" }),
        el("p", { id: "usage-note", class: "hint usage-filter-note", role: "status" }),
        el(
          "div",
          { class: "results-line" },
          el("span", { id: "result-count" }),
          el(
            "label",
            { class: "group-switch", title: "Junta en una sola fila las copias del mismo agente o skill" },
            el("input", {
              type: "checkbox",
              id: "group-copies",
              ...(grouping() ? { checked: "" } : {}),
              onchange: (e) => {
                prefs.group = e.target.checked;
                savePrefs();
                renderContent();
              },
            }),
            "Agrupar copias",
          ),
          el(
            "button",
            {
              type: "button",
              id: "live-summary",
              class: "live-summary",
              "aria-haspopup": "dialog",
              onclick: liveDialog,
            },
            "Sin actividad observada",
          ),
        ),
        sourceIssues(data.roots).length
          ? el(
              "div",
              { class: "source-alert", role: "status" },
              el(
                "span",
                {},
                `${sourceIssues(data.roots).length} fuentes con incidencias. El inventario puede estar incompleto.`,
              ),
              button("Revisar fuentes", sourceDialog, "button quiet"),
            )
          : null,
        el(
          "div",
          { class: "workspace-body" },
          el("section", { id: "stage", "aria-label": "Inventario y ciudad" }),
          el("aside", {
            id: "detail",
            class: "detail",
            "aria-label": "Detalle seleccionado",
          }),
        ),
      ),
    ),
    el(
      "footer",
      { id: "status", class: "status", role: "status", "aria-live": "polite" },
      "Fuentes locales · Definiciones disponibles para explorar",
    ),
  );
  renderContent();
}
// ---- Live activity: polling, mapping, dialogs ----
const POLL_MS = 1500,
  POLL_BACKOFF_MS = 5000;
let live = null,
  liveMap = liveMapping(null),
  pollTimer = null,
  pollBusy = false,
  sceneSignature = null;
const REASONS = {
  ambiguous: "varios roles comparten ese nombre",
  "no-match": "ninguna carpeta de proyecto coincide",
};
function roleChip(roleIds) {
  const sessions = roleIds.split(" ").flatMap((id) => liveMap.byRole[id] ?? []);
  if (!sessions.length) return null;
  const sources = [...new Set(sessions.map((s) => sourceLabel(s.source)))];
  return el(
    "span",
    { class: "chip-live" },
    `${stateLabel(sessions[0].state)} · ${sources.join(", ")}${sessions.length > 1 ? ` ×${sessions.length}` : ""}`,
  );
}
function refreshRoleChips() {
  document
    .querySelectorAll("[data-live-role]")
    .forEach((slot) =>
      slot.replaceChildren(roleChip(slot.dataset.liveRole) ?? ""),
    );
}
function updateLiveSummary() {
  const node = document.querySelector("#live-summary");
  if (!node) return;
  const active = (live?.sessions ?? []).filter((s) => s?.active).length;
  const observed = !!live?.connected;
  node.dataset.active = String(observed && active > 0);
  node.replaceChildren(
    el("span", { class: "live-dot", "aria-hidden": "true" }),
    observed ? `${active} activas` : "Sin actividad observada",
  );
}
function fillNowBody(container) {
  const idleOpen = container.querySelector(".live-idle")?.open === true;
  container.replaceChildren();
  const sessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const active = sessions.filter((s) => s?.active);
  if (!live?.connected)
    container.append(
      el(
        "p",
        {},
        "Todavía no se ha recibido ningún evento. Conecta los hooks de Claude Code o Codex para ver aquí tus sesiones.",
      ),
    );
  else if (!active.length)
    container.append(el("p", {}, "No hay sesiones activas ahora mismo."));
  const places = new Map();
  for (const [spaceId, entry] of Object.entries(liveMap.bySpace)) {
    const name = org().spaces.find((s) => s.id === spaceId)?.name;
    if (name)
      for (const s of entry.sessions)
        places.set(s, [...(places.get(s) ?? []), name]);
  }
  const reasons = new Map(liveMap.unassigned.map((u) => [u.session, u.reason]));
  const row = (session) => {
    const names = places.get(session);
    return el(
      "div",
      { class: "live-session" },
      el("strong", {}, session.agentType || "Sesión principal"),
      el(
        "span",
        {},
        [
          stateLabel(session.state),
          session.tool ? `herramienta ${session.tool}` : null,
          elapsedLabel(session.ageSeconds),
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      el(
        "span",
        { class: "hint" },
        names?.length
          ? `Edificio: ${names.join(", ")}`
          : `Sin asignar (${REASONS[reasons.get(session)] ?? "sin coincidencia"})`,
      ),
      session.cwd ? el("span", { class: "mono hint" }, session.cwd) : null,
    );
  };
  for (const source of [...new Set(active.map((s) => s.source))])
    container.append(
      el(
        "section",
        { class: "live-group" },
        el("h3", {}, sourceLabel(source)),
        ...active.filter((s) => s.source === source).map(row),
      ),
    );
  if (liveMap.idle.length) {
    const idle = el(
      "details",
      { class: "live-idle" },
      el("summary", {}, `En reposo (${liveMap.idle.length})`),
      ...liveMap.idle.map(row),
    );
    idle.open = idleOpen;
    container.append(idle);
  }
}
function liveDialog() {
  const body = el(
    "div",
    { class: "dialog-body" },
    el("div", { id: "live-now-body" }),
    el(
      "p",
      { class: "hint" },
      "Solo cuentan las sesiones en curso. Las que esperan un permiso se marcan como Esperando.",
    ),
    button("Conectar hooks", hooksDialog, "button"),
  );
  const d = showDialog("Ahora", body);
  d.classList.add("live-dialog");
  d.dataset.kind = "now";
  fillNowBody(body.querySelector("#live-now-body"));
}
function snippetBlock(title, target) {
  const pre = el("pre", { class: "snippet-box", tabindex: "0" });
  pre.textContent = target?.snippet ?? "";
  const note = el("p", { class: "copy-note", role: "status" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      note.textContent = "Copiado.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      note.textContent =
        "No se pudo copiar automáticamente. El texto está seleccionado: pulsa Ctrl+C.";
    }
  };
  return el(
    "section",
    { class: "live-group" },
    el("h3", {}, title),
    el(
      "p",
      {},
      "Fusiona este fragmento en: ",
      el("span", { class: "mono" }, target?.file ?? "—"),
    ),
    pre,
    button("Copiar", copy, "button"),
    note,
  );
}
function hooksDialog() {
  const connect = live?.connect;
  const body = el(
    "div",
    { class: "dialog-body" },
    el(
      "p",
      {},
      "Agent City nunca edita estos archivos: copia el fragmento y fusiónalo tú. Si la ciudad está cerrada, los hooks fallan en silencio y no afectan a tus sesiones.",
    ),
    connect
      ? [
          snippetBlock("Claude Code", connect.claudeCode),
          snippetBlock("Codex", connect.codex),
        ]
      : el(
          "p",
          { role: "alert" },
          "No se pudo leer la configuración de conexión. Vuelve a intentarlo en unos segundos.",
        ),
    connect?.hookScript
      ? el(
          "p",
          { class: "hint" },
          "Script de hook: ",
          el("span", { class: "mono" }, connect.hookScript),
        )
      : null,
  );
  const d = showDialog("Conectar hooks", body);
  d.classList.add("live-dialog");
}
function refreshLive() {
  try {
    if (!data) return;
    liveMap = liveMapping(live, data.catalog, org());
    updateLiveSummary();
    refreshRoleChips();
    const signature = JSON.stringify(
      [
        Object.entries(liveMap.bySpace).map(([id, e]) => [id, e.count, e.states]),
        Object.entries(liveMap.byRole).map(([id, s]) => [id, s.length]),
      ],
    );
    if (signature !== sceneSignature) {
      sceneSignature = signature;
      if (city?.applyLive) city.applyLive(liveMap.bySpace, liveMap.byRole);
      else applyLive(document.querySelector(".map"), liveMap.bySpace);
    }
    if (dialog?.open && dialog.dataset.kind === "now") {
      const target = dialog.querySelector("#live-now-body");
      if (target) fillNowBody(target);
    }
  } catch {}
}
async function pollLive() {
  clearTimeout(pollTimer);
  if (document.hidden || pollBusy) return;
  pollBusy = true;
  let next = POLL_MS;
  try {
    live = await api("/api/live");
    refreshLive();
  } catch {
    next = POLL_BACKOFF_MS;
  } finally {
    pollBusy = false;
    pollTimer = setTimeout(pollLive, next);
  }
}
function startLivePolling() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollLive();
  });
  pollLive();
}
// ---- Real usage: loading, list chip, detail section, dialog ----
const plural = (n, one, many) => (n === 1 ? one : many);
const times = (n) => `${n} ${plural(n, "vez", "veces")}`;
// Any failure means «sin datos» (usage = null), never a broken app. Returns true when it loaded.
async function loadUsage() {
  try {
    usage = await api("/api/usage");
    return true;
  } catch {
    usage = null;
    return false;
  }
}
// Re-render only what shows usage, so a late answer never rebuilds the city for nothing.
const usageViewsChanged = () => {
  if (prefs.filters.usage || prefs.selected || prefs.view === "list") renderContent();
};
const usageChip = (key) => {
  const entry = usageMatched().matched.byKey.get(key);
  return entry?.total > 0
    ? el("span", { class: "usage-chip", title: usageState(entry, usage).label }, `usado ${entry.total}×`)
    : null;
};
function usageSection(item) {
  const key = groupKey(item);
  if (key.startsWith("id:")) return null;
  const box = el("section", { class: "usage", "aria-label": "Uso" }, el("h3", {}, "Uso"));
  if (!usageHasData(usage)) {
    box.append(
      el(
        "p",
        { class: "hint" },
        usage
          ? "Aún no hay registro de uso. Se rellena con los hooks de Claude Code o importando tu historial desde «Uso»."
          : "Los datos de uso no están disponibles ahora mismo.",
      ),
    );
    return box;
  }
  const { matched, groups } = usageMatched(),
    entry = matched.byKey.get(key),
    state = usageState(entry, usage),
    copies = groups.find((g) => g.key === key)?.count ?? 1;
  box.append(el("p", { class: "usage-state", "data-used": String(state.used) }, state.label));
  if (state.used)
    box.append(
      el("p", {}, `Últimos 30 días: ${times(entry.last30)} · Últimos 7 días: ${times(entry.last7)}`),
      ...(entry.names.some((n) => groupKey({ kind: item.kind, name: n }) !== key)
        ? [el("p", { class: "hint" }, `Registrado como: ${entry.names.join(", ")}`)]
        : []), // Node.append turns null into the text "null"
    );
  box.append(
    el(
      "p",
      { class: "hint" },
      `${copies > 1 ? `Describe las ${copies} copias juntas: el registro es por nombre. ` : ""}Solo cuenta lo que ven los hooks de Claude Code o el historial importado; «sin uso registrado» no significa que no se use.`,
    ),
  );
  return box;
}

const usageUi = { period: "all", step: null, busy: false };
function usageDialog() {
  const ui = usageUi;
  ui.step = null;
  const holder = el("div", { class: "usage-main" });
  const note = el("p", { class: "hint usage-note", role: "status" });
  const error = el("p", { class: "form-error", role: "alert" });
  const ranking = (title, kind) => {
    const { matched, groups } = usageMatched(),
      rows = rankUsage(
        groups
          .filter((g) => g.kind === kind && matched.byKey.has(g.key))
          .map((g) => ({ ...matched.byKey.get(g.key), name: g.name, group: g })),
        ui.period,
      ).slice(0, 10);
    return el(
      "section",
      { class: "usage-list" },
      el("h3", {}, title),
      rows.length
        ? el(
            "ol",
            {},
            ...rows.map((r) =>
              el(
                "li",
                {},
                button(r.name, () => selectItem(r.group.primary.id), "text-button"),
                el("span", { class: "usage-meta" }, `${times(usageCount(r, ui.period))} · última vez ${r.lastAt ?? "—"}`),
              ),
            ),
          )
        : el("p", { class: "hint" }, "Ninguno con uso registrado en este periodo."),
    );
  };
  const show = (kids, focus) => {
    holder.replaceChildren(...kids.filter(Boolean));
    if (focus) holder.querySelector(focus)?.focus();
  };
  const draw = (focus) => {
    const kids = [
      el(
        "p",
        {},
        "Cuenta los lanzamientos de subagentes y las llamadas a skills que ven los hooks de Claude Code. No cuenta los slash commands que escribes tú, ni Codex, ni nada anterior a la fecha de inicio del registro, salvo que importes tu historial de Claude Code.",
      ),
    ];
    if (!usage) {
      const retry = button(
        "Reintentar",
        async () => {
          await loadUsage();
          usageViewsChanged();
          draw("[data-act=retry]");
        },
        "button primary",
      );
      retry.dataset.act = "retry";
      return show(
        [
          ...kids,
          el("p", { class: "notice" }, "No se pudieron cargar los datos de uso. Comprueba que la ciudad está actualizada y vuelve a intentarlo."),
          retry,
        ],
        focus,
      );
    }
    const since = usageSince(usage),
      hist = usage.history?.importedAt ? usage.history : null;
    kids.push(
      el(
        "p",
        { class: "usage-coverage" },
        since ? `Registro desde ${since}.` : "Aún no hay registro de uso.",
        usage.liveSince && usage.liveSince !== since ? ` Hooks en vivo desde ${usage.liveSince}.` : "",
        hist
          ? ` Historial de Claude Code importado${hist.from ? ` (${hist.from} – ${hist.to ?? "…"})` : ""}.`
          : " Historial de Claude Code sin importar.",
      ),
    );
    if (usage.skillTracking === false)
      kids.push(
        el(
          "p",
          { class: "notice" },
          "El hook instalado aún no envía el nombre de las skills; actualiza la copia del hook para registrarlas. Los agentes se registran con normalidad.",
        ),
      );
    const { matched, groups } = usageMatched(),
      sum = usageSummary(groups, matched, ui.period),
      unmatched = rankUsage(matched.unmatched, ui.period),
      period = el("div", { class: "view-toggle usage-period", role: "group", "aria-label": "Periodo" });
    for (const [key, label] of [
      ["30", "Últimos 30 días"],
      ["all", "Todo"],
    ]) {
      const b = button(label, () => ((ui.period = key), draw(`[data-period="${key}"]`)), "button");
      b.dataset.period = key;
      b.setAttribute("aria-pressed", String(ui.period === key));
      period.append(b);
    }
    kids.push(
      period,
      el(
        "p",
        { class: "usage-summary" },
        el("strong", {}, `${sum.agents.used} de ${sum.agents.total} ${plural(sum.agents.total, "agente único", "agentes únicos")}`),
        ` con uso registrado${ui.period === "30" ? " en los últimos 30 días" : ""} · `,
        el("strong", {}, `${sum.skills.used} de ${sum.skills.total} ${unitLabel("skill", sum.skills.total, true)}`),
        ".",
      ),
      el(
        "p",
        { class: "hint" },
        "«Sin uso registrado» no es lo mismo que «no se usa»: solo consta lo que han visto los hooks o el historial importado.",
      ),
      ranking("Agentes más usados", "role"),
      ranking("Skills más usadas", "skill"),
    );
    if (unmatched.length)
      kids.push(
        el(
          "details",
          { class: "usage-unmatched" },
          el("summary", {}, `Usados sin definición en el catálogo (${unmatched.length})`),
          el(
            "p",
            { class: "hint" },
            "Nombres con uso registrado que no coinciden con ninguna definición conectada: por ejemplo agentes integrados de Claude Code (Explore) o skills de carpetas que no has conectado.",
          ),
          el(
            "ol",
            {},
            ...unmatched.slice(0, 50).map((u) =>
              el(
                "li",
                {},
                el("span", { class: "mono" }, u.name),
                el(
                  "span",
                  { class: "usage-meta" },
                  `${u.kind === "skill" ? "skill" : "agente"} · ${times(usageCount(u, ui.period))} · última vez ${u.lastAt ?? "—"}`,
                ),
              ),
            ),
          ),
          unmatched.length > 50 ? el("p", { class: "hint" }, `+${unmatched.length - 50} más`) : null,
        ),
      );
    const confirm = (text, label, go, back) =>
      el(
        "div",
        { class: "usage-confirm", role: "group", "aria-label": "Confirmación", tabindex: "-1" },
        el("p", {}, text),
        el(
          "div",
          { class: "guide-actions" },
          button(label, go, "button primary"),
          button(
            "Cancelar",
            () => {
              ui.step = null;
              draw(`[data-act=${back}]`);
            },
            "button quiet",
          ),
        ),
      );
    const act = (label, step, cls) => {
      const b = button(
        label,
        () => {
          ui.step = step;
          note.textContent = error.textContent = "";
          draw(".usage-confirm");
        },
        cls,
      );
      b.dataset.act = step;
      b.disabled = ui.busy;
      return b;
    };
    kids.push(
      ui.step === "import"
        ? confirm(
            "Se leerán los archivos de conversación de Claude Code de esta carpeta solo para contar llamadas a skills y a subagentes. No se guarda ni se muestra nada más.",
            "Confirmar",
            () =>
              run("/api/usage/import-history", "Leyendo el historial… puede tardar unos segundos.", (r) => {
                const i = r.imported ?? {};
                return `Historial importado: ${countOf(i.agent ?? 0, "lanzamiento", "lanzamientos")} de agentes y ${countOf(i.skill ?? 0, "llamada", "llamadas")} a skills, en ${countOf(i.files ?? 0, "archivo leído", "archivos leídos")}${i.skipped ? ` (${i.skipped} omitidos)` : ""}${i.from ? `, del ${i.from} al ${i.to ?? "…"}` : ""}.`;
              }),
            "import",
          )
        : ui.step === "clear"
          ? confirm(
              "Se borrarán los contadores de uso que guarda Agent City. No se toca ninguna conversación ni archivo de Claude Code, y el registro empezará de nuevo.",
              "Confirmar y borrar",
              () => run("/api/usage/clear", "Borrando…", () => "Registro de uso borrado."),
              "clear",
            )
          : el(
              "div",
              { class: "guide-actions" },
              act("Importar historial de Claude Code", "import", "button primary"),
              act("Borrar registro de uso", "clear", "button quiet"),
            ),
    );
    show(kids, focus);
  };
  async function run(path, working, done) {
    if (ui.busy) return;
    ui.busy = true;
    document.body.classList.add("busy");
    note.textContent = working;
    error.textContent = "";
    try {
      const result = await api(path, {});
      usage = result.usage ?? result;
      note.textContent = done(result);
      usageViewsChanged();
    } catch (e) {
      note.textContent = "";
      error.textContent = e.message;
    } finally {
      ui.busy = false;
      ui.step = null;
      document.body.classList.remove("busy");
      if (dialog?.isConnected && dialog.dataset.kind === "usage") draw("[data-act=import]");
    }
  }
  const d = showDialog("Uso real", el("div", { class: "dialog-body" }, holder, note, error));
  d.classList.add("live-dialog", "usage-dialog");
  d.dataset.kind = "usage";
  const eyebrow = d.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = "REGISTRO LOCAL";
  draw();
}
async function bootstrap() {
  try {
    const usageLoad = loadUsage(); // in parallel and never rejects: a failure only means «sin datos»
    data = await api("/api/bootstrap");
    const rendered = usage;
    render();
    startLivePolling();
    usageLoad.then(() => {
      if (usage !== rendered) usageViewsChanged();
    });
    if (!data.roots?.length && !guideSeen()) guideDialog();
  } catch (error) {
    app.replaceChildren(
      el(
        "main",
        { class: "initial-status" },
        el("h1", {}, "No podemos abrir la ciudad todavía"),
        el("p", { role: "alert" }, error.message),
        button("Volver a intentar", bootstrap, "button primary"),
      ),
    );
  }
}
bootstrap();
