# 天机阁 · Códice de Algoritmos

> [English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Tianjige es un plugin de DeepSeek Harness que convierte un *códice de algoritmos* personal en algo
que un agente puede consultar directamente: **219 algoritmos** en **13 dominios** (render,
geometría, neural-3d, animación, física, procedural, audio, ai-ml, multitudes, sistemas de juego,
matemática numérica, pipeline, herramientas), cada uno con un enlace a una implementación real —
más una página lateral navegable para humanos.

El plugin es la *interfaz*; el códice vive en el repositorio `algo-hub` del nivel superior
(`data/algorithms.json` + `data/taxonomy.json`). El paquete no incluye datos, así que la misma
instalación sirve para cualquier directorio de datos.

## Features

- **Búsqueda** — `tianji_search` encuentra algoritmos por lenguaje natural o palabras clave, con
  filtros por dominio, clave de función, madurez y «tiene implementación lista». Coincidencia
  estricta primero, parcial como respaldo, con enlaces clicables.
- **Ficha** — `tianji_get` devuelve una entrada completa: funcionamiento, compromisos, complejidad,
  artículos, implementaciones, variantes del mismo cometido y advertencias.
- **Preguntar** — `tianji_ask` responde una pregunta de diseño desde el códice y, si se pide
  (`findNew: true`), busca en la web algoritmos que no están en él.
- **Barrido** — `tianji_sweep` busca algoritmos nuevos en la web, los convierte en borradores bajo
  `data/pending/` y puede ejecutarse a diario (`action=status|start|config`).
- **Curaduría** — `tianji_stage` / `tianji_update` / `tianji_review` / `tianji_review_mark` /
  `tianji_stats` / `tianji_usage` cubren alta, edición, revisión, auditoría y contabilidad de tokens.
- **Interfaz** — una fila en la barra lateral izquierda abre una vista de página completa con cuatro
  pestañas (Códice / Arena / Barrido / Preguntar); la misma página existe también como pestaña de
  la barra derecha.

## Install

El paquete es el directorio `tianjige-plugin/`. Instálalo en un perfil de DSH y actívalo:

```powershell
# desde npm (paquete publicado)
dsh plugin --profile web add dsh-tianjige

# o desde un tarball empaquetado
dsh plugin --profile web add ./dsh-tianjige-<version>.tgz

# Opción 1 — herramienta plugin_manager
#   action=install_bundle, target=link:C:/path/to/algo-hub/tianjige-plugin
# Opción 2 — package.json del perfil: dependencia link: + entrada en dsh.profile.bundles
```

Reinicia DSH después: la mitad host se importa una sola vez al arrancar y recargar la página no la
vuelve a cargar. Antes de reiniciar puedes comprobar el código con `node --check host.js` y
`node --check lib/*.mjs`.

## Configuration

El plugin inserta una fila (`id: tianjige`) mediante `cordis.patch.yml`. Ambas claves son opcionales:

| Clave | Valor por defecto | Significado |
|---|---|---|
| `dataDir` | directorio padre del paquete (= raíz del repositorio) | raíz del códice con `data/` y `server/ai.mjs` |
| `defaultLimit` | `8` | filas devueltas por `tianji_search` |

```yaml
- insert:
    - id: tianjige
      name: dsh-tianjige
      config:
        dataDir: D:\wherever\algo-hub   # opcional, por defecto se deduce
        defaultLimit: 8
```

## Data layout

```
algo-hub/
  data/
    algorithms.json   # códice combinado (219 entradas)
    taxonomy.json     # los 13 dominios
    review.json       # registro de revisión
    coverage.json     # matriz de cobertura del barrido
    staging/          # material por agente pendiente de fusión
    pending/          # borradores de IA pendientes de revisión humana
    runs/             # registro de cada barrido
    logs/             # errores de la página (client-YYYY-MM-DD.log)
  server/ai.mjs       # lógica de IA de la edición web (el plugin usa lib/ai.mjs)
  tools/algohub.py    # CLI: validate / merge / export / stats / coverage / record-run / snapshot …
```

Cuando el plugin se instala desde npm no hay repositorio a su alrededor, así que el primer arranque copia la biblioteca inicial incluida (`seed/algorithms.json`, `seed/taxonomy.json`) en `~/.dsh/tianjige` y todas las escrituras van allí. `dataDir` (o `DSH_TIANJIGE_DATA_DIR`) lo sobrescribe; una instalación link / de desarrollo sigue usando la raíz del repositorio.

## Compatibility

- **DSH** `>=0.2.1-rc.2` (`dsh.engines.dsh`), **Node** `^22.19.0 || >=24.0.0`
- Sin dependencia de `@deepseek-ai/*`: el host no importa nada y las capas de datos e IA se cargan
  por import dinámico, así que una copia dentro del perfil nunca oculta la versión del runtime.
- Las herramientas de IA (preguntar / barrido / revisión asistida) necesitan `DEEPSEEK_API_KEY`:
  variable de entorno o línea `DEEPSEEK_API_KEY:` en `~/.dsh/.credentials.yaml`. Sin clave, el resto
  sigue funcionando y las herramientas de IA devuelven `AI_NO_KEY`.
- La única dependencia peer es `react` (mitad cliente, la aporta el harness).

## Tools

| Herramienta | Para qué |
|---|---|
| `tianji_search` | Buscar entradas (`query`, opcional `domain` / `functionKey` / `maturity` / `hasImpl` / `limit`) |
| `tianji_get` | Ficha completa por `id` |
| `tianji_ask` | Pregunta de diseño en lenguaje natural (`task`, opcional `findNew`) |
| `tianji_sweep` | Barrido: `action=status` / `start` / `config` (programación automática) |
| `tianji_stage` | Añadir candidato (escribe `data/staging/`, espera fusión humana) |
| `tianji_update` | Editar una entrada existente (copia de seguridad automática) |
| `tianji_review` / `tianji_review_mark` | Cola de revisión: listar / registrar veredicto |
| `tianji_stats` | Auditoría: recuento, dominios, cobertura de implementaciones, revisión |
| `tianji_usage` | Libro de tokens de IA (leer / borrar / limpiar / retención) |

## UI surfaces

El plugin registra tres sitios:

- `sidebar.panellist` — una fila «天机阁» en la barra lateral izquierda (`order: 120`)
- `main` — vista de página completa abierta desde esa fila (pestañas Códice / Arena / Barrido / Preguntar)
- `sidebar.right.pane.tab` — la misma página como pestaña de la barra derecha

Los datos de la página pasan por rutas del host `/api/tianjige/{library,meta,sweep,ask,review,usage,write,log}`,
que solo aceptan peticiones de loopback. Sin el servicio `webServer` el plugin se degrada a
«solo herramientas, sin página».

## Troubleshooting

- **No aparece nada tras instalar** — reinicia DSH; luego revisa el campo `application` de `plugin_manager`.
- **La página dice «estado de barrido no disponible»** — suele ser un módulo que no carga (por ejemplo
  falta `lib/ai.mjs`); la ruta escribe el error en la respuesta 500 de `/api/tianjige/meta`. Comprueba
  con `node --check lib/sweep.mjs`.
- **`AI_NO_KEY` en `tianji_ask`** — configura la clave como se describe en Compatibility.
- **Validación de datos** — `python tools/algohub.py validate` (0 errores, 0 avisos) y `doctor`.

## Development

- Host: `host.js` (entrada, herramientas + rutas), `lib/sweep.mjs`, `lib/ai.mjs` (llamadas y prompts),
  `lib/usage.mjs` (libro de tokens), `lib/entries.mjs` (lectura/escritura de entradas).
- Cliente: `lib/client.js` (React, bundle de un solo archivo registrado en un slot).
- Pruebas: `npm test` ejecuta `node --test test/smoke.test.mjs` — sin red, sin dependencias, contra
  `test/fixtures/`; no toca datos reales ni requiere instalar el plugin.
- Comprobaciones estáticas: `dsh-plugin-dev check --strict` (paquete de la skill `dsh-plugin-guide`) y
  `node --check` en cada entrada.

## License

MIT — ver [LICENSE](LICENSE).
