# Agent City

![Agent City: una ciudad isométrica 3D donde cada edificio agrupa a tus agentes](assets/city.png)

Una colonia de ciencia ficción para organizar agentes, skills y proyectos en tu equipo. Ciudad isométrica, interiores por salas y una vista de lista con buscador, usando la misma información.

**Inventario y organización, 100 % local.** Los personajes representan definiciones de agentes; no ejecutan tareas. No hace falta cuenta, servidor externo ni instalar paquetes. Licencia [MIT](LICENSE).

## Arrancar en Windows

Necesitas Python 3.11 o posterior. No hay paquetes que instalar.

1. Abre **Iniciar.cmd** con doble clic.
2. El navegador abrirá **http://127.0.0.1:4317**.
3. Mantén la consola abierta mientras usas la ciudad. Para detenerla, pulsa `Ctrl+C` en esa consola.

También puedes ejecutar `./Iniciar.ps1` desde PowerShell. Si la política de PowerShell impide abrir scripts, utiliza `Iniciar.cmd`; no es necesario cambiar la política del sistema.

Los lanzadores buscan Python con el lanzador `py` de Windows (3.13, 3.12, 3.11 o 3.14) y, si no existe, con `python`. Así funcionan aunque el `PATH` de Windows esté incompleto, algo habitual cuando se han instalado varias versiones de Python. Si no encuentran ninguna, lo dicen y esperan una tecla.

Los lanzadores guardan los datos en `.local/` dentro del proyecto. Puedes cambiar el puerto o la carpeta de datos:

```powershell
python -m agent_city --port 4318 --data-dir .local --open
```

Sin `--data-dir`, el módulo utiliza una carpeta dedicada de datos del usuario. Elige siempre el mismo directorio para recuperar la misma organización.

## Primer recorrido

1. **Conectar fuentes:** elige una sugerencia o introduce una carpeta concreta. Selecciona Roles o Skills y pulsa **Autorizar e importar**. Elegir una sugerencia solo rellena el formulario.
2. **Lista:** busca una definición y consulta su descripción y procedencia. Las variantes con igual nombre mantienen identidades y rutas distintas.
3. **Asignar edificio o proyecto:** coloca un agente en uno o varios espacios. Oficina y Casa son contextos de proyecto; Taller y Estudio agrupan especialidades. Las asignaciones explícitas permiten encontrar un proyecto dentro de su taller.
4. **Vincular skill:** añade las habilidades que quieras relacionar con un agente. Son vínculos de organización personal, no una comprobación de compatibilidad operativa.
5. **Ciudad:** entra en un edificio, selecciona un robot y consulta sus skills. La Biblioteca también permite explorar el catálogo completo sin asignar cada habilidad a un agente.

¿Primera vez? Pulsa **Empezar aquí** en la cabecera: una guía de pocos pasos explica qué es la ciudad, qué son los edificios, agentes y skills, y cómo conectarlos. Se abre sola la primera vez si aún no has conectado ninguna fuente.

La búsqueda distingue tipos, edificios, proyectos y especialidades declaradas en las fuentes. Normaliza mayúsculas y acentos. La vista de lista permite acceder a todos los elementos aunque el mapa solo muestre hasta tres personajes por edificio. Puedes acercar, alejar, desplazar y centrar el mapa.

Las asignaciones y los vínculos persisten tras reiniciar. **Deshacer** recupera cambios recientes de organización. Actualizar una fuente conserva la organización y distingue un archivo desaparecido de una lectura fallida.

## Poblar la ciudad en tres pasos

1. **Conectar todo lo encontrado:** en el panel de fuentes, la ciudad busca en tu equipo las carpetas de agentes y skills de Claude Code (incluidos los plugins instalados), Codex, `~/.agents`, Hermes, Gemini, ZCode y OpenClaw, y muestra cuántas definiciones hay en cada una. Marcas las que quieras, confirmas y se importan de una vez. Las fuentes que ya estaban conectadas se omiten, y un fallo en una no detiene las demás.
2. **Organizar automáticamente:** propone un edificio para cada agente sin asignar según las palabras de su nombre, su especialidad y el inicio de su descripción (Estudio, Taller, Biblioteca o Torre de control). Cada robot muestra el motivo, puedes desmarcar los que no te convenzan y aplicarlo. La propuesta nunca toca asignaciones existentes ni crea vínculos con skills. Todo es reversible con **Deshacer**. Es una heurística de palabras clave: revisa los motivos antes de aplicar.
3. **Detectar proyectos:** indica una carpeta (por ejemplo `C:\Proyectos`) y la ciudad lista sus subcarpetas. Eliges cuáles son proyectos y si pertenecen a Oficina o a Casa; se crean con su ruta, de modo que la actividad en vivo ilumine el edificio correcto. Solo lee los nombres de las carpetas.

Las carpetas que son enlaces o uniones (muy habituales en ZCode y OpenClaw, que apuntan a `~/.agents/skills`) no se siguen: sus skills entran por la carpeta original, sin duplicados.

## Fuentes y datos

Se admiten definiciones TOML de agentes de Codex, archivos `.md` de agentes de Claude Code y archivos `SKILL.md` con metadatos compatibles. El lector de cabeceras admite nombres/descripciones escalares y bloques de texto; no es un motor YAML general. No sigue `prompt_file`, no abre el cuerpo de los archivos Markdown, no abre notas enlazadas ni ejecuta instrucciones importadas. Los archivos originales permanecen intactos.

La ficha de cada definición muestra lo que el archivo declara (herramientas, modelo, invocación, versión, licencia, archivos hermanos), cada dato con su nivel: **Declarado** o **Verificado**. Un dato que no aparece se muestra como «No declarado», nunca como «no puede». Los roles de Codex no declaran modelo ni herramientas: los heredan del runtime que los ejecute.

Rutas habituales: `%USERPROFILE%\.codex\agents`, `%USERPROFILE%\.claude\agents`, `%USERPROFILE%\.agents\skills` y `%USERPROFILE%\.codex\skills`. También puedes añadir carpetas de skills de plugins explícitamente; conectar estas tres rutas no acredita un inventario exhaustivo de todos los plugins instalados.

Cada importación tiene límites: 2.000 definiciones, 20.000 entradas, profundidad 8 y 64 KiB por definición. Una exploración incompleta o fallida conserva la información anterior y muestra un aviso. Los archivos omitidos o incompatibles aparecen en los diagnósticos de la fuente.

`.local/`, las bases de datos, las sesiones y los archivos de agentes/skills importados **no se incluyen en Git**. El repositorio contiene aplicación, pruebas y documentación. La copia local de SQLite es una ayuda de recuperación; todavía no hay interfaz de restauración ni exportación portátil.

## Ciudad 3D

La ciudad se dibuja por defecto en 3D isométrico con WebGL (three.js 0.186.1, licencia MIT, incluido en `web/vendor/`; no se descarga nada al ejecutar). Seis edificios con volumen propio, robots por edificio, luces y sombras. Arrastra para mover; los botones acercan, alejan y centran. Los edificios se iluminan con la actividad real (ver más abajo) y no se mueven ni brillan sin eventos.

El botón **3D / 2D** de los controles alterna con el mapa SVG anterior. Si el navegador no admite WebGL, o se pierde el contexto gráfico, la ciudad cambia sola a 2D. Los nombres de los edificios son botones reales, así que todo se puede usar con teclado, y la vista Lista sigue ofreciendo lo mismo en texto. Con `prefers-reduced-motion` no hay animaciones: solo un brillo fijo.

Los edificios y robots son formas generadas con código, con estilo de maqueta de ciencia ficción, no modelos 3D fotorrealistas.

## Actividad en vivo (Claude Code y Codex)

La ciudad puede mostrar qué sesiones están trabajando ahora mismo: el edificio correspondiente se ilumina con un indicador de texto («2 trabajando») y el botón **Activas** de la cabecera abre el panel **Ahora**. Solo se enciende con eventos reales; sin eventos no hay luz.

Funciona con *hooks*: un pequeño script (`hooks/agent_city_hook.py`) que Claude Code o Codex ejecutan en cada evento y que envía a la ciudad solo el tipo de evento, la sesión, la carpeta, el nombre de la herramienta y el agente. **Nunca** envía prompts, argumentos ni respuestas. Si la ciudad está cerrada, falla en silencio y no afecta a tus sesiones.

Para activarlo: abre **Conectar hooks** en el panel Ahora, copia el fragmento de cada herramienta y fusiónalo en `~/.claude/settings.json` y `~/.codex/hooks.json`. La ciudad nunca edita esos archivos. Para saber en qué edificio se enciende una sesión:

1. Si es un subagente con el nombre de un agente que ya colocaste en un edificio, se enciende ese edificio.
2. Si no, se usa la carpeta de trabajo: añade la **carpeta del proyecto** al crear o editar un proyecto y se enciende el edificio de ese proyecto.
3. Si nada coincide, aparece como «Sin asignar» con el motivo; la ciudad no inventa un edificio.

Límites: una sesión sin eventos durante 60 s deja de contar como activa (300 s si está dentro de una herramienta larga o esperando un permiso). Cada llamada a una herramienta añade unos 100 ms por el arranque de Python; si lo notas, quita `PostToolUse` del fragmento. El estado vive solo en memoria y se pierde al cerrar la ciudad. De momento solo hay hooks para Claude Code y Codex.

## Pruebas

```powershell
npm test
```

Ejecuta las pruebas de Python (`unittest`) y de Node (`node --test`) sin descargar dependencias.

## Limitaciones

- Los personajes son definiciones de agentes: la ciudad no los ejecuta ni lanza tareas.
- No hay todavía interfaz para restaurar copias, exportar la organización ni eliminar fuentes.
- La reconciliación guiada de fuentes movidas y la lectura completa del cuerpo de los documentos no están implementadas.
- Los límites de importación (2.000 definiciones por fuente) están pensados para equipos personales, no para inventarios masivos.

## Licencia

[MIT](LICENSE). three.js se incluye en `web/vendor/` bajo su propia licencia MIT.
