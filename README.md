# 天机阁 · Algorithm Codex

> [English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

The plugin is the *interface*; the codex itself lives in the `algo-hub` repository one level up
(`data/algorithms.json` + `data/taxonomy.json`). A standalone install carries a seed snapshot (`seed/`)
and seeds `~/.dsh/tianjige` on first run, so the same package works without the repository.

## Features

- **Search** — `tianji_search` finds algorithms by natural language or keywords, with filters for
  domain, function key, maturity and “has a ready implementation”. Strict match first, partial
  match as a fallback, clickable repo/package links in the result.
- **Dossier** — `tianji_get` returns one full entry: how it works, tradeoffs, complexity, papers,
  implementations, sibling variants of the same function, caveats.
- **Ask** — `tianji_ask` lets the model answer a design question from the codex first, and opt in
  to a web search for algorithms outside it (`findNew: true`).
- **Sweep** — `tianji_sweep` searches the web for new algorithms, turns them into candidate drafts
  under `data/pending/`, and can run on a daily schedule (`action=status|start|config`).
- **Curation** — `tianji_stage` / `tianji_update` / `tianji_review` / `tianji_review_mark` /
  `tianji_stats` / `tianji_usage` cover adding, editing, reviewing, auditing and token accounting.
- **UI** — a left-sidebar row opens a full-page view with four tabs (Codex / Arena / Sweep / Ask),
  and the same page is also available as a right-sidebar tab.

## Install

The package is the `tianjige-plugin/` directory. Install it into a DSH profile and enable it:

```powershell
# from the GitHub release (no npm account needed)
dsh plugin --profile desktop add https://github.com/MengXingXiaoMing/dsh-tianjige/releases/download/v1.3.0/dsh-tianjige-1.3.0.tgz

# from npm, once the package is published
dsh plugin --profile desktop add dsh-tianjige

# from a local checkout (development): add the directory itself
dsh plugin --profile desktop add C:\path\to\algo-hub\tianjige-plugin
```

Use your own profile name instead of `desktop` if you run a different one. Restart DSH afterwards:
the host half is imported once at startup and a page refresh does not reload it. Before restarting you
can smoke-check the sources with `node --check host.js` and `node --check lib/*.mjs`.
## Configuration

The plugin inserts one row (`id: tianjige`) through `cordis.patch.yml`. Both keys are optional:

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | parent directory of this package (= repository root) | codex root containing `data/` and `server/ai.mjs` |
| `defaultLimit` | `8` | default number of rows returned by `tianji_search` |

```yaml
- insert:
    - id: tianjige
      name: dsh-tianjige
      config:
        dataDir: D:\wherever\algo-hub   # optional, derived by default
        defaultLimit: 8
```

## Data layout

```
algo-hub/
  data/
    algorithms.json   # merged codex (219 entries)
    taxonomy.json     # the 13 domains
    review.json       # review ledger
    coverage.json     # sweep coverage matrix (written once a sweep ran)
    staging/          # per-agent material waiting for merge
    pending/          # AI drafts waiting for human review
    runs/             # one ledger per sweep run
    logs/             # page error reports (client-YYYY-MM-DD.log)
  server/ai.mjs       # AI logic for the old web edition (the plugin uses lib/ai.mjs)
  tools/algohub.py    # CLI: validate / merge / export / stats / coverage / record-run / snapshot …
```

When the plugin is installed from npm there is no repository around it, so the first run copies the bundled starter library (`seed/algorithms.json`, `seed/taxonomy.json`) into `~/.dsh/tianjige` and keeps every write there. Set `dataDir` (or `DSH_TIANJIGE_DATA_DIR`) to override; a link / development install keeps using the repository root.

## Compatibility

- **DSH** `>=0.2.1-rc.2` (`dsh.engines.dsh`), **Node** `^22.19.0 || >=24.0.0`
- No `@deepseek-ai/*` dependency at all: the host entry has zero imports, and both the data layer
  and the AI layer are loaded by dynamic import, so a copy inside a profile can never shadow the
  runtime version.
- AI tools (ask / sweep / AI-assisted review) need `DEEPSEEK_API_KEY`: an environment variable, or
  a `DEEPSEEK_API_KEY:` line in `~/.dsh/.credentials.yaml`. Without a key the other tools keep
  working and the AI tools return `AI_NO_KEY`.
- The only peer dependency is `react` (client half, provided by the harness).

## Tools

| Tool | Purpose |
|---|---|
| `tianji_search` | Search entries (`query`, optional `domain` / `functionKey` / `maturity` / `hasImpl` / `limit`) |
| `tianji_get` | Full dossier by `id` |
| `tianji_ask` | Natural-language design question (`task`, optional `findNew` web search) |
| `tianji_sweep` | Sweep: `action=status` / `start` / `config` (daily auto-sweep switch and interval) |
| `tianji_stage` | Stage a new candidate (writes `data/staging/`, waits for human merge) |
| `tianji_update` | Edit an existing entry in place (automatic backup) |
| `tianji_review` / `tianji_review_mark` | Review queue: list items / record a verdict |
| `tianji_stats` | Codex audit: entry count, domain spread, implementation coverage, review progress |
| `tianji_usage` | AI token ledger (read / delete / clear / retention) |

## UI surfaces

The plugin registers three seats:

- `sidebar.panellist` — one row “天机阁” in the left sidebar (`order: 120`)
- `main` — a full-page view opened from that row (tabs: Codex / Arena / Sweep / Ask)
- `sidebar.right.pane.tab` — the same page as a right-sidebar tab

Page data goes through host routes `/api/tianjige/{library,meta,sweep,ask,review,usage,write,log}`,
which accept loopback requests only. Without a `webServer` service the plugin degrades to
“tools only, no page”.

## Troubleshooting

- **Nothing shows up after install** — restart DSH first; then check the `application` field
  returned by `plugin_manager`.
- **Page says “sweep status unavailable”** — usually a dependency module failed to load (for
  example a missing `lib/ai.mjs`); the route writes the error into the `/api/tianjige/meta` 500
  response. Check with `node --check lib/sweep.mjs`.
- **`AI_NO_KEY` from `tianji_ask`** — configure the key as described under Compatibility.
- **Data validation** — `python tools/algohub.py validate` (expect 0 errors, 0 warnings) and
  `doctor` for reference checks.

## Development

- Host: `host.js` (entry, tools + routes), `lib/sweep.mjs` (sweep / review / ask),
  `lib/ai.mjs` (AI calls and prompts), `lib/usage.mjs` (token ledger), `lib/entries.mjs`
  (entry read/write helpers).
- Client: `lib/client.js` (React, single-file bundle registered into a slot).
- Tests: `npm test` runs `node --test test/smoke.test.mjs` — offline, zero dependencies, against
  `test/fixtures/`; it never touches real data and does not need the plugin to be installed.
- Static checks: `dsh-plugin-dev check --strict` (from the `dsh-plugin-guide` skill package) and
  `node --check` on every entry.

## Publishing

There are two distribution channels; both are optional and GitHub stays the source of truth.

**Cut a release (maintainers).** Bump `version`, run `npm test` and `dsh-plugin-dev check --strict`,
then pack the tarball and attach it to a GitHub release:

```powershell
npm pack
gh release create v<version> dsh-tianjige-<version>.tgz --title "v<version>" --notes "..."
```

**npm (optional).** After `npm login`, run `npm publish --access public`. Users then install with
`dsh plugin --profile desktop add dsh-tianjige`. Publishing to npm is not required for the marketplace.

**DSH marketplace.** Registration lives in [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):
one file per plugin at `data/plugins/<owner>__<repo>.yml`, holding `url`, `name`, `category`, an optional
`tarball`, and `description.en` (plus `description.zh` if you can). The requirements are a public repo,
`dsh.bundle.patch` in `package.json` with `cordis.patch.yml` at the root, the `dsh-plugin` topic, a
description that matches the code, and a repository that is at least one day old — that last one is
checked automatically, to filter out repos created minutes before a PR. Open the PR from your fork;
once merged, the registry entry is what the marketplace lists.

**Curated lists (optional).** `DshMarketPlace/awesome-dsh-plugin` keeps `data/curated.yml`. A PR there is
a recommendation rather than a registration, so send it after the registry entry has been merged.
## License

MIT — see [LICENSE](LICENSE).
