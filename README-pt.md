# 天机阁 · Códice de Algoritmos

> [English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Tianjige é um plugin do DeepSeek Harness que transforma um *códice de algoritmos* pessoal em algo
que um agente pode consultar diretamente: **219 algoritmos** em **13 domínios** (renderização,
geometria, neural-3d, animação, física, procedural, áudio, ai-ml, multidões, sistemas de jogo,
matemática numérica, pipeline, ferramentas), cada um com um link para uma implementação real —
além de uma página lateral navegável para pessoas.

O plugin é a *interface*; o códice fica no repositório `algo-hub` um nível acima
(`data/algorithms.json` + `data/taxonomy.json`). O pacote não inclui dados, então a mesma instalação
serve para qualquer diretório de dados.

## Features

- **Busca** — `tianji_search` encontra algoritmos por linguagem natural ou palavras-chave, com
  filtros por domínio, chave de função, maturidade e «tem implementação pronta». Correspondência
  estrita primeiro, parcial como alternativa, com links clicáveis.
- **Ficha** — `tianji_get` devolve uma entrada completa: funcionamento, tradeoffs, complexidade,
  artigos, implementações, variantes da mesma função e ressalvas.
- **Perguntar** — `tianji_ask` responde uma pergunta de projeto a partir do códice e, se pedido
  (`findNew: true`), pesquisa na web algoritmos que não estão nele.
- **Varredura** — `tianji_sweep` busca algoritmos novos na web, gera rascunhos em `data/pending/`
  e pode rodar diariamente (`action=status|start|config`).
- **Curadoria** — `tianji_stage` / `tianji_update` / `tianji_review` / `tianji_review_mark` /
  `tianji_stats` / `tianji_usage` cobrem inclusão, edição, revisão, auditoria e contabilidade de tokens.
- **Interface** — uma linha na barra lateral esquerda abre uma página completa com quatro abas
  (Códice / Arena / Varredura / Perguntar); a mesma página existe como aba da barra direita.

## Install

O pacote é o diretório `tianjige-plugin/`. Instale em um perfil do DSH e habilite:

```powershell
# via npm (pacote publicado)
dsh plugin --profile web add dsh-tianjige

# ou de um tarball empacotado
dsh plugin --profile web add ./dsh-tianjige-<version>.tgz

# Opção 1 — ferramenta plugin_manager
#   action=install_bundle, target=link:C:/path/to/algo-hub/tianjige-plugin
# Opção 2 — package.json do perfil: dependência link: + entrada em dsh.profile.bundles
```

Reinicie o DSH depois: a metade host é importada uma única vez na inicialização e recarregar a
página não a recarrega. Antes de reiniciar, verifique com `node --check host.js` e
`node --check lib/*.mjs`.

## Configuration

O plugin insere uma linha (`id: tianjige`) via `cordis.patch.yml`. As duas chaves são opcionais:

| Chave | Padrão | Significado |
|---|---|---|
| `dataDir` | diretório pai deste pacote (= raiz do repositório) | raiz do códice com `data/` e `server/ai.mjs` |
| `defaultLimit` | `8` | linhas retornadas por `tianji_search` |

```yaml
- insert:
    - id: tianjige
      name: dsh-tianjige
      config:
        dataDir: D:\wherever\algo-hub   # opcional, derivado por padrão
        defaultLimit: 8
```

## Data layout

```
algo-hub/
  data/
    algorithms.json   # códice combinado (219 entradas)
    taxonomy.json     # os 13 domínios
    review.json       # registro de revisão
    coverage.json     # matriz de cobertura da varredura
    staging/          # material por agente aguardando merge
    pending/          # rascunhos de IA aguardando revisão humana
    runs/             # registro de cada varredura
    logs/             # erros da página (client-YYYY-MM-DD.log)
  server/ai.mjs       # lógica de IA da edição web (o plugin usa lib/ai.mjs)
  tools/algohub.py    # CLI: validate / merge / export / stats / coverage / record-run / snapshot …
```

Quando o plugin é instalado via npm não há repositório ao redor, então a primeira execução copia a biblioteca inicial incluída (`seed/algorithms.json`, `seed/taxonomy.json`) para `~/.dsh/tianjige` e todas as gravações ficam lá. `dataDir` (ou `DSH_TIANJIGE_DATA_DIR`) sobrescreve; instalação link / de desenvolvimento continua usando a raiz do repositório.

## Compatibility

- **DSH** `>=0.2.1-rc.2` (`dsh.engines.dsh`), **Node** `^22.19.0 || >=24.0.0`
- Sem dependência de `@deepseek-ai/*`: o host não importa nada e as camadas de dados e IA são
  carregadas por import dinâmico, então uma cópia dentro do perfil nunca oculta a versão do runtime.
- Ferramentas de IA (perguntar / varredura / revisão assistida) precisam de `DEEPSEEK_API_KEY`:
  variável de ambiente ou linha `DEEPSEEK_API_KEY:` em `~/.dsh/.credentials.yaml`. Sem chave, o
  restante continua funcionando e as ferramentas de IA retornam `AI_NO_KEY`.
- A única dependência peer é `react` (metade cliente, fornecida pelo harness).

## Tools

| Ferramenta | Para quê |
|---|---|
| `tianji_search` | Buscar entradas (`query`, opcional `domain` / `functionKey` / `maturity` / `hasImpl` / `limit`) |
| `tianji_get` | Ficha completa por `id` |
| `tianji_ask` | Pergunta de projeto em linguagem natural (`task`, opcional `findNew`) |
| `tianji_sweep` | Varredura: `action=status` / `start` / `config` (agendamento automático) |
| `tianji_stage` | Adicionar candidato (grava `data/staging/`, aguarda merge humano) |
| `tianji_update` | Editar uma entrada existente (backup automático) |
| `tianji_review` / `tianji_review_mark` | Fila de revisão: listar / registrar veredito |
| `tianji_stats` | Auditoria: contagem, domínios, cobertura de implementações, revisão |
| `tianji_usage` | Livro de tokens de IA (ler / apagar / limpar / retenção) |

## UI surfaces

O plugin registra três assentos:

- `sidebar.panellist` — uma linha «天机阁» na barra lateral esquerda (`order: 120`)
- `main` — página completa aberta por essa linha (abas Códice / Arena / Varredura / Perguntar)
- `sidebar.right.pane.tab` — a mesma página como aba da barra direita

Os dados da página passam por rotas do host `/api/tianjige/{library,meta,sweep,ask,review,usage,write,log}`,
que aceitam apenas requisições de loopback. Sem o serviço `webServer` o plugin degrada para
«apenas ferramentas, sem página».

## Troubleshooting

- **Nada aparece após instalar** — reinicie o DSH; depois confira o campo `application` do `plugin_manager`.
- **A página diz «status da varredura indisponível»** — geralmente um módulo que não carrega (por
  exemplo falta `lib/ai.mjs`); a rota grava o erro na resposta 500 de `/api/tianjige/meta`. Verifique
  com `node --check lib/sweep.mjs`.
- **`AI_NO_KEY` em `tianji_ask`** — configure a chave como descrito em Compatibility.
- **Validação de dados** — `python tools/algohub.py validate` (0 erros, 0 avisos) e `doctor`.

## Development

- Host: `host.js` (entrada, ferramentas + rotas), `lib/sweep.mjs`, `lib/ai.mjs` (chamadas e prompts),
  `lib/usage.mjs` (livro de tokens), `lib/entries.mjs` (leitura/escrita de entradas).
- Cliente: `lib/client.js` (React, bundle de arquivo único registrado em um slot).
- Testes: `npm test` executa `node --test test/smoke.test.mjs` — offline, sem dependências, contra
  `test/fixtures/`; não toca dados reais nem exige instalar o plugin.
- Verificações estáticas: `dsh-plugin-dev check --strict` (pacote da skill `dsh-plugin-guide`) e
  `node --check` em cada entrada.

## License

MIT — veja [LICENSE](LICENSE).
