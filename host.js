/**
 * 天机阁 · 算法天书 —— DSH 宿主侧插件（host half）。
 *
 * 把 algo-hub 那本"天书"（196+ 门术法的 JSON）和它的问天书 AI 检索，暴露成
 * agent 可以直接调用的工具，不再依赖网页。
 *
 * 入口零 import：`ctx.tools.register` 收普通对象字面量，因此本包不解析任何
 * `@deepseek-ai/*` 依赖（那些包放进 dependencies 会静默遮蔽运行时版本）。
 * 唯一的外部模块是数据目录里的 `server/ai.mjs`，按绝对路径动态 import。
 *
 * 配置（cordis.patch.yml 的 config 块，全部可选）：
 *   dataDir: 天书数据目录（含 data/algorithms.json）；缺省时自动推导，
 *            从 npm 安装会落到 ~/.dsh/tianjige 并从包内 seed/ 初始化
 *   defaultLimit: 搜索默认返回条数（默认 8）
 */

import { readFile, writeFile, appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const name = 'tianjige';

/**
 * 必须声明 inject，否则 Cordis 拒绝访问服务：
 * 实测只写 ['tools'] 时，`ctx.get('webServer')` / `ctx.webServer` 抛
 * `cannot get property "webServer" without inject`，于是侧栏页面的数据路由
 * `/api/tianjige/library` 根本没注册，页面只能看到「读不到数据（HTTP 404）」。
 * 依据：同机官方插件 `@linxin666/dsh-client-ui-task-board` 的 inject 里也列了 webServer。
 */
export const inject = ['tools', 'webServer'];

/**
 * 数据目录解析（三级）：
 *   1. 配置里的 dataDir（相对路径按进程 cwd 解析）
 *   2. 环境变量 DSH_TIANJIGE_DATA_DIR
 *   3. 自动推导：
 *      - 开发 / link 安装：本包上一级是天书仓库（有 data/algorithms.json）→ 用它
 *      - 从 npm 安装：包目录在 node_modules 里，只读且没有 data/，于是把包内
 *        seed/ 的起始库复制到用户目录 ~/.dsh/tianjige，运行期读写都在那里
 *
 * 不写死本机绝对路径——插件被 link / 打包 / 换机器安装时都能落到可用位置。
 */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_DIR = resolve(PACKAGE_DIR, '..');

/** 首次运行时把包内 seed 复制到可写目录（已存在就跳过）。 */
function ensureSeed(dir) {
  const target = join(dir, 'data', 'algorithms.json');
  if (existsSync(target)) return dir;
  const seed = join(PACKAGE_DIR, 'seed');
  mkdirSync(join(dir, 'data'), { recursive: true });
  for (const f of ['algorithms.json', 'taxonomy.json']) {
    if (existsSync(join(seed, f))) copyFileSync(join(seed, f), join(dir, 'data', f));
  }
  return dir;
}

export function resolveDataDir(cfg) {
  const explicit = cfg.dataDir ?? process.env.DSH_TIANJIGE_DATA_DIR;
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  if (existsSync(join(REPO_DIR, 'data', 'algorithms.json'))) return REPO_DIR;
  return ensureSeed(join(homedir(), '.dsh', 'tianjige'));
}

/* ------------------------------------------------------------------ 数据层 */

function makeStore(dataDir) {
  let cache = { mtime: 0, payload: null, taxonomy: null };

  const file = () => join(dataDir, 'data', 'algorithms.json');
  const taxFile = () => join(dataDir, 'data', 'taxonomy.json');

  async function load() {
    const f = file();
    if (!existsSync(f)) throw new Error(`找不到天书数据库：${f}（检查插件配置 dataDir）`);
    const st = await import('node:fs/promises').then((m) => m.stat(f));
    if (cache.payload && st.mtimeMs === cache.mtime) return cache.payload;
    const payload = JSON.parse(await readFile(f, 'utf8'));
    const taxonomy = existsSync(taxFile()) ? JSON.parse(await readFile(taxFile(), 'utf8')) : null;
    cache = { mtime: st.mtimeMs, payload, taxonomy };
    return payload;
  }

  return {
    load,
    dataDir,
    path: (...p) => join(dataDir, ...p),
    taxonomy: () => cache.taxonomy,
  };
}

/* -------------------------------------------------- 侧栏页面用的整包数据 */

/** 读一个 JSON 文件，不存在就返回 null（不抛）。 */
async function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 列目录里的文件名（不存在就空数组）。 */
async function listDir(path) {
  try {
    return (await readdir(path)).filter((f) => !f.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/**
 * 把库、分类法、采风覆盖、复核台账打成一份给侧栏页面用的 JSON。
 * 页面自己做筛选与检索，所以这里给全量条目（本机 localhost，1MB 量级可接受）。
 */
export async function buildLibraryPayload(baseDir) {
  const dataDir = join(baseDir, 'data');
  const [algos, tax, cov, rev, pending, staging, snapshots] = await Promise.all([
    readJsonOrNull(join(dataDir, 'algorithms.json')),
    readJsonOrNull(join(dataDir, 'taxonomy.json')),
    readJsonOrNull(join(dataDir, 'coverage.json')),
    readJsonOrNull(join(dataDir, 'review.json')),
    listDir(join(dataDir, 'pending')),
    listDir(join(dataDir, 'staging')),
    listDir(join(dataDir, 'snapshots')),
  ]);
  const entries = algos?.entries ?? [];

  const byDomain = {};
  const byMaturity = {};
  const byConfidence = {};
  const tagCount = new Map();
  const fnMap = new Map();
  const implTypeSet = new Set();
  const platformSet = new Set();
  const yearSet = new Set();
  let implLinks = 0;

  for (const e of entries) {
    byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
    byMaturity[e.maturity] = (byMaturity[e.maturity] ?? 0) + 1;
    byConfidence[e.confidence] = (byConfidence[e.confidence] ?? 0) + 1;
    for (const t of e.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    for (const i of e.implementations ?? []) {
      implLinks += 1;
      if (i.type) implTypeSet.add(i.type);
    }
    for (const p of e.platforms ?? []) platformSet.add(p);
    if (Number.isFinite(e.year)) yearSet.add(e.year);
    const key = e.functionKey ?? e.id;
    if (!fnMap.has(key)) fnMap.set(key, { key, label: e.functionLabel ?? e.name, domain: e.domain, entryIds: [] });
    fnMap.get(key).entryIds.push(e.id);
  }

  const functions = [...fnMap.values()]
    .map((f) => ({ ...f, count: f.entryIds.length, isContested: f.entryIds.length > 1 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: entries.length,
      functions: functions.length,
      multi: functions.filter((f) => f.isContested).length,
      withImpl: entries.filter((e) => (e.implementations ?? []).length > 0).length,
      implLinks,
      byDomain,
      byMaturity,
      byConfidence,
    },
    facets: {
      tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
      implTypes: [...implTypeSet].sort(),
      platforms: [...platformSet].sort(),
      years: [...yearSet].sort((a, b) => b - a),
    },
    taxonomy: tax,
    functions,
    coverage: cov,
    review: rev ?? {},
    pending,
    staging,
    snapshots,
    entries,
  };
}

/** 只服务本机回环请求（页面就在同一台机器上）。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/* ------------------------------------------------------------------ 检索打分 */

const W = { name: 6, alias: 5, func: 4, tag: 3, summary: 2.6, impl: 2.4, domain: 2, how: 1.4 };

function hay(e) {
  return {
    name: String(e.name ?? '').toLowerCase(),
    alias: (e.aliases ?? []).join(' ').toLowerCase(),
    func: `${e.functionKey ?? ''} ${e.functionLabel ?? ''}`.toLowerCase(),
    tag: (e.tags ?? []).join(' ').toLowerCase(),
    summary: String(e.summary ?? '').toLowerCase(),
    impl: (e.implementations ?? []).map((i) => `${i.name ?? ''} ${i.lang ?? ''}`).join(' ').toLowerCase(),
    domain: `${e.domain ?? ''} ${e.subdomain ?? ''}`.toLowerCase(),
    how: String(e.howItWorks ?? '').toLowerCase(),
  };
}

/** 中文没有空格：把查询词拆成"拉丁部分 + 中文段 + 中文 2-gram"。
 *  - 拉丁部分（如 ssao、mesh）必须原样命中，避免「zzzz不存在的词」靠中文瞎命中；
 *  - 中文段整词命中优先；整词不中时退到 2-gram（「软体飘带」→「飘带」），
 *    但只认两种可靠的 2-gram：命中两个以上，或单个命中了 name/alias/法门/标签这类强字段。 */
function analyze(token) {
  const latin = token.match(/[a-z0-9][a-z0-9+.#_/-]*/gi) ?? [];
  const cjkRuns = token.match(/[\u4e00-\u9fa5]+/g) ?? [];
  const bigrams = [];
  for (const run of cjkRuns) {
    if (run.length >= 3) for (let i = 0; i + 2 <= run.length; i++) bigrams.push(run.slice(i, i + 2));
  }
  return { latin: [...new Set(latin.map((s) => s.toLowerCase()))], cjkRuns, bigrams: [...new Set(bigrams)], short: cjkRuns.every((r) => r.length <= 2) };
}

function bestWeight(h, term) {
  let best = 0;
  for (const [field, weight] of Object.entries(W)) {
    if (h[field] && h[field].includes(term)) best = Math.max(best, weight);
  }
  return best;
}

/** 单个查询词对一条术法的得分；0 = 这个词完全没命中。 */
function matchToken(h, a) {
  let best = 0;
  for (const l of a.latin) {
    const w = bestWeight(h, l);
    if (!w) return 0; // 拉丁部分必须命中
    best = Math.max(best, w);
  }
  for (const run of a.cjkRuns) best = Math.max(best, bestWeight(h, run));
  if (best) return best;
  if (a.latin.length) return 0; // 不是纯中文，不做 2-gram 兜底
  let hits = 0, bw = 0;
  for (const b of a.bigrams) {
    const w = bestWeight(h, b);
    if (w) { hits++; bw = Math.max(bw, w); }
  }
  if (hits >= 2) return bw * 0.8;
  if (hits === 1 && (a.short || bw >= 3)) return bw * 0.8;
  return 0;
}

/** 严格模式：每个词都必须命中，否则 -1。 */
function scoreOf(h, tokens) {
  let total = 0;
  for (const a of tokens) {
    const s = matchToken(h, a);
    if (!s) return -1;
    total += s;
  }
  return total;
}

function partialScore(h, tokens) {
  let total = 0;
  for (const a of tokens) total += matchToken(h, a);
  return total;
}

/* ------------------------------------------------------------------ 渲染 */

const link = (u) => `[${String(u).replace(/^https?:\/\//, '').slice(0, 70)}](${u})`;

function card(e, taxonomy, { long = false } = {}) {
  const dom = (taxonomy?.domains ?? []).find((d) => d.id === e.domain);
  const scroll = dom?.scroll ? `${dom.scroll} · ` : '';
  const out = [];
  out.push(`### ${e.name}${e.aliases?.length ? `（${e.aliases.slice(0, 3).join(' / ')}）` : ''}`);
  out.push(`- id：\`${e.id}\` ｜ ${scroll}${dom?.label ?? e.domain} / ${e.subdomain}`);
  out.push(`- 法门：${e.functionLabel ?? e.functionKey}（\`${e.functionKey}\`） ｜ ${e.year ?? '—'} ｜ 成熟度 ${e.maturity} ｜ 置信度 ${e.confidence}`);
  out.push(`- 一句话：${e.summary ?? ''}`);
  if (long) {
    if (e.howItWorks) out.push(`- 原理：${e.howItWorks}`);
    if (e.whyItMatters) out.push(`- 为什么值得用：${e.whyItMatters}`);
    if (e.tradeoffs) out.push(`- 取舍：${e.tradeoffs}`);
    if (e.complexity) out.push(`- 复杂度：${e.complexity}`);
    if (e.bestFor) out.push(`- 适用：${e.bestFor}`);
    if (e.avoidWhen) out.push(`- 不适用：${e.avoidWhen}`);
    if (e.inputs) out.push(`- 输入：${e.inputs}`);
    if (e.outputs) out.push(`- 输出：${e.outputs}`);
    if (e.platforms?.length) out.push(`- 平台：${e.platforms.join(' / ')}`);
    if (e.tags?.length) out.push(`- 标签：${e.tags.join(' ')}`);
    const q = e.quality ?? '—', p = e.performance ?? '—', d = e.difficulty ?? '—';
    out.push(`- 评分：质量 ${q}/5 ｜ 性能 ${p}/5 ｜ 难度 ${d}/5`);
    if (e.caveats) out.push(`- 坑：${e.caveats}`);
  }
  if (e.implementations?.length) {
    out.push(`- 现成法器（${e.implementations.length}）：`);
    for (const i of e.implementations.slice(0, long ? 10 : 4)) {
      out.push(`  - [${i.type}] ${i.name}${i.license ? ` · ${i.license}` : ''}${i.lang ? ` · ${i.lang}` : ''} → ${link(i.url)}`);
    }
  } else {
    out.push('- 现成法器：暂无');
  }
  if (long) {
    if (e.papers?.length) {
      out.push(`- 论文：`);
      for (const p of e.papers.slice(0, 6)) out.push(`  - ${p.title}${p.venue ? ` · ${p.venue}` : ''} → ${link(p.url)}`);
    }
    if (e.sources?.length) {
      out.push(`- 来源：`);
      for (const s of e.sources.slice(0, 8)) out.push(`  - [${s.kind ?? 'link'}] ${s.title} → ${link(s.url)}`);
    }
    if (e.demoUrl) out.push(`- 演示：${link(e.demoUrl)}`);
    if (e.variants?.length) {
      out.push(`- 同法门其他方案：`);
      for (const v of e.variants) out.push(`  - ${v.name ?? v.id}${v.note ? ` —— ${v.note}` : ''}${v.url ? ` → ${link(v.url)}` : ''}${v.id ? ` （库内 \`${v.id}\`）` : ''}`);
    }
    if (e.relatedIds?.length) out.push(`- 相关：${e.relatedIds.map((r) => `\`${r}\``).join('、')}`);
    out.push(`- 入库 ${e.addedAt ?? '—'} · 最近核实 ${e.lastChecked ?? '—'}`);
  }
  return out.join('\n');
}

const text = (t) => [{ type: 'text', text: t }];

/* ------------------------------------------------------------------ 插件主体 */

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const dataDir = resolveDataDir(cfg);
  const store = makeStore(dataDir);
  const defaultLimit = Number(cfg.defaultLimit) > 0 ? Number(cfg.defaultLimit) : 8;

  /** 带 mtime 缓存的 taxonomy（给卷名用）。 */
  const tax = () => store.taxonomy();

  /* 侧栏页面（main slot）读这份数据；没有 webServer 服务就静默跳过，只提供工具。 */
  const ROUTE_PATH = '/api/tianjige/library';
  const ROUTE_META = '/api/tianjige/meta';
  const ROUTE_SWEEP = '/api/tianjige/sweep';
  const ROUTE_ASK = '/api/tianjige/ask';
  const ROUTE_REVIEW = '/api/tianjige/review';
  const ROUTE_USAGE = '/api/tianjige/usage';
  const ROUTE_WRITE = '/api/tianjige/write';
  const ROUTE_LOG = '/api/tianjige/log';
  const selftest = { at: new Date().toISOString(), dataDir, route: ROUTE_PATH, routes: [], client: false, webServer: 'none', diag: {} };

  const libraryHandler = async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }
    if (!isLoopback(req)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    try {
      const payload = await buildLibraryPayload(dataDir);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err?.message ?? err));
    }
  };

  /* ---------------------------------------------------------- 路由小工具 */

  /** 统一 JSON 回包：本机回环地址用，禁缓存。 */
  const sendJson = (res, status, value) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(value));
  };

  /** 每个路由共用的守卫：回环校验 + 方法校验 + 异常兜底（全部回落成 JSON，别把页面打瞎）。 */
  const guarded = (methods, fn) => async (req, res) => {
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'forbidden: only loopback' });
    if (!methods.includes(req.method)) return sendJson(res, 405, { error: `method not allowed: ${req.method}` });
    try {
      return await fn(req, res);
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };

  /** 读 JSON 请求体（上限 64 KB，够页面用了）。 */
  const readJsonBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('请求体太大（64 KB 上限）');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  };

  /** 采风/问答/复核的实现在 lib/sweep.mjs：按需加载，出问题只影响这几个路由。 */
  let sweepMod = null;
  const sweep = async () => (sweepMod ??= await import(new URL('./lib/sweep.mjs', import.meta.url).href));

  /** token 账本（lib/usage.mjs）：独立加载，账本坏了不影响采风。 */
  let usageMod = null;
  const usageLib = async () => (usageMod ??= await import(new URL('./lib/usage.mjs', import.meta.url).href));

  /** 素材写入（lib/entries.mjs）：只在有人真的改素材时加载。 */
  let entriesMod = null;
  const entriesLib = async () => (entriesMod ??= await import(new URL('./lib/entries.mjs', import.meta.url).href));

  /** 分类法（校验素材要用）；顺手触发一次 load，把 taxonomy 填进缓存。 */
  const loadTaxonomy = async () => {
    await store.load();
    return store.taxonomy() ?? { domains: [] };
  };

  const metaHandler = guarded(['GET'], async (_req, res) => {
    const mod = await sweep();
    sendJson(res, 200, await mod.readMeta(dataDir));
  });

  const sweepHandler = guarded(['GET', 'POST'], async (req, res) => {
    const mod = await sweep();
    if (req.method === 'GET') return sendJson(res, 200, mod.getJob() ?? { state: 'idle' });
    const body = await readJsonBody(req);
    /* 设置：{action:'config', auto?, minIntervalHours?} —— 页面上的开关与最短间隔走这条 */
    if (String(body.action ?? '') === 'config') {
      const patch = {};
      if (typeof body.auto === 'boolean') patch.auto = body.auto;
      if (Number.isFinite(Number(body.minIntervalHours))) patch.minIntervalHours = Number(body.minIntervalHours);
      const config = Object.keys(patch).length ? await mod.writeConfig(dataDir, patch) : await mod.readConfig(dataDir);
      const state = await mod.readSweepState(dataDir);
      return sendJson(res, 200, { ok: true, config, check: mod.checkAutoEligible(config, state) });
    }
    const started = await mod.startSweep(dataDir, {
      domains: body.domains,
      angles: body.angles,
      budgetMs: body.budgetMs,
      trigger: body.trigger === 'agent' ? 'agent' : 'plugin',
    });
    if (started.refused) return sendJson(res, 409, started);
    sendJson(res, started.alreadyRunning ? 409 : 200, started);
  });

  const askHandler = guarded(['POST'], async (req, res) => {
    const body = await readJsonBody(req);
    const mod = await sweep();
    sendJson(res, 200, await mod.ask(dataDir, body.q ?? body.question, { findNew: body.findNew === true }));
  });

  const reviewHandler = guarded(['POST'], async (req, res) => {
    const body = await readJsonBody(req);
    const mod = await sweep();
    sendJson(res, 200, await mod.markReview(dataDir, body.id, body.status, body.note));
  });

  /** token 账本：GET 看账（?days=7&limit=50），POST 删账（delete / clear / retention）。 */
  const usageHandler = guarded(['GET', 'POST'], async (req, res) => {
    const mod = await usageLib();
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const days = Number(url.searchParams.get('days')) || 7;
      const limit = Number(url.searchParams.get('limit')) || 50;
      return sendJson(res, 200, await mod.summarizeUsage(dataDir, { days, limit }));
    }
    const body = await readJsonBody(req);
    const action = String(body.action ?? '');
    if (action === 'delete') return sendJson(res, 200, await mod.clearUsage(dataDir, { ids: body.ids }));
    if (action === 'clear') return sendJson(res, 200, await mod.clearUsage(dataDir, { olderThanDays: body.olderThanDays, all: body.all === true }));
    if (action === 'retention') return sendJson(res, 200, await mod.setRetention(dataDir, body.days));
    return sendJson(res, 400, { error: `usage: 不认识的 action=${action}（支持 delete / clear / retention）` });
  });

  /** 素材写入：POST {action:'stage'|'update'}，校验不过一律 400，绝不半写。 */
  const writeHandler = guarded(['POST'], async (req, res) => {
    const body = await readJsonBody(req);
    const mod = await entriesLib();
    const taxonomy = await loadTaxonomy();
    const action = String(body.action ?? '');
    if (action === 'stage') return sendJson(res, 200, await mod.stageEntry(dataDir, body.entry, taxonomy));
    if (action === 'update') return sendJson(res, 200, await mod.updateEntry(dataDir, body.id, body.patch, taxonomy));
    return sendJson(res, 400, { error: `write: 不认识的 action=${action}（支持 stage / update）` });
  });

  /** 页面报错落盘：POST {level,message,stack,url,at} → data/logs/client-<date>.log（JSONL，单条 ≤4 KB）。 */
  const logHandler = guarded(['POST'], async (req, res) => {
    const body = await readJsonBody(req);
    const line = JSON.stringify({
      at: String(body.at ?? new Date().toISOString()).slice(0, 40),
      level: String(body.level ?? 'error').slice(0, 16),
      message: String(body.message ?? '').slice(0, 2000),
      stack: String(body.stack ?? '').slice(0, 2000),
      url: String(body.url ?? '').slice(0, 400),
    });
    if (line.length > 4096) throw new Error('日志单条太大（4 KB 上限）');
    const dir = join(dataDir, 'data', 'logs');
    await mkdir(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(join(dir, `client-${day}.log`), line + '\n', 'utf8');
    return sendJson(res, 200, { ok: true });
  });

  /* 诊断（每次 apply 落进 selftest.diag）：把 ctx 上跟服务解析有关的东西逐个探一遍，
     单项失败不影响其它项，下次 reload 直接看这份文件就知道该用哪种取法。 */
  const probe = (name, fn) => {
    try {
      selftest.diag[name] = String(fn());
    } catch (err) {
      selftest.diag[name] = 'throws: ' + String(err?.message ?? err);
    }
  };
  probe('inject', () => JSON.stringify(inject));
  probe('typeof ctx.inject', () => typeof ctx.inject);
  probe('typeof ctx.get', () => typeof ctx.get);
  probe('typeof ctx.effect', () => typeof ctx.effect);
  probe('typeof ctx.webServer', () => typeof ctx.webServer);
  probe('typeof ctx.webServer.register', () => typeof ctx.webServer?.register);

  /* 注册路由：照官方 task-board 的写法在 effect 里现场取 `scope.webServer`（不提前缓存），
     `ctx.inject([...])` 可用时优先用它——cordis 会等 webServer 就绪后才回调。 */
  const ROUTE_TABLE = [
    [ROUTE_PATH, libraryHandler],
    [ROUTE_META, metaHandler],
    [ROUTE_SWEEP, sweepHandler],
    [ROUTE_ASK, askHandler],
    [ROUTE_REVIEW, reviewHandler],
    [ROUTE_USAGE, usageHandler],
    [ROUTE_WRITE, writeHandler],
    [ROUTE_LOG, logHandler],
  ];

  const mountRoute = (scope) =>
    scope.effect(() => {
      const handles = ROUTE_TABLE.map(([path, handler]) => scope.webServer.register({ kind: 'exact', path, handler }));
      selftest.webServer = 'ok';
      selftest.routes = ROUTE_TABLE.map(([path]) => path);
      return () => {
        for (const handle of handles) {
          try {
            handle?.dispose?.();
          } catch {
            /* ignore */
          }
        }
      };
    }, 'tianjige: library routes');

  try {
    /* 先写标记再挂载：cordis 的 ctx.inject 回调可能同步执行，挂载成功时 effect 会把
       selftest.webServer 改写成 'ok'，这里不能反过来把它盖掉。 */
    if (typeof ctx.inject === 'function') {
      selftest.webServer = 'inject-scoped';
      ctx.inject(['webServer'], mountRoute);
    } else {
      selftest.webServer = 'effect-lazy';
      mountRoute(ctx);
    }
  } catch (err) {
    selftest.webServer = 'error: ' + String(err?.message ?? err);
    /* 纯 CLI 部署没有 webServer，忽略 */
  }

  /* 自检落盘：宿主进程里跑完 apply 就写一份，证明路由注册与客户端 bundle 都在位。
     晚 300ms 再写——`ctx.inject` 的回调是异步触发的，等它把 webServer 跑完再落盘，
     selftest.webServer 才会从 'inject-scoped' 变成 'ok'。 */
  const clientPath = fileURLToPath(new URL('./lib/client.js', import.meta.url));
  stat(clientPath)
    .then(() => {
      selftest.client = true;
    })
    .catch(() => {
      selftest.client = false;
    })
    .then(() => new Promise((resolve) => setTimeout(resolve, 300)))
    .then(() => writeFile(join(dataDir, 'plugin-selftest.json'), JSON.stringify(selftest, null, 2), 'utf8'))
    .catch(() => {
      /* 只读部署忽略 */
    });

  ctx.tools.register({
    name: 'tianji_search',
    description: [
      '搜索《天机阁 · 算法天书》里收录的算法（graphics / rendering / animation / physics / AI 等 13 卷）。',
      '当用户问"某个效果/需求该用什么算法、有没有现成实现、和别的方案比怎么样"时用它，返回可点击的仓库/包链接。',
      '纯本地检索，毫秒级返回。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或关键词，中英文都可以。例："软体飘带 实时"、"screen space ambient occlusion"、"mesh decimation"' },
        domain: { type: 'string', description: '只在这一卷里找（卷 id，如 rendering / animation / physics / ai-ml / tooling）' },
        functionKey: { type: 'string', description: '只找这个法门（功能），如 ambient-occlusion / mesh-decimation / flocking' },
        hasImpl: { type: 'boolean', description: '只看有现成实现的条目（true）或只看没有实现的（false）' },
        maturity: { type: 'string', description: '成熟度过滤：research / experimental / production / legacy' },
        limit: { type: 'number', description: `返回条数，默认 ${defaultLimit}` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const payload = await store.load();
      const q = String(args.query ?? '').trim();
      if (!q) throw new Error('tianji_search: query 不能为空');
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).map(analyze);
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : defaultLimit, 25);

      let pool = payload.entries ?? [];
      if (args.domain) pool = pool.filter((e) => e.domain === args.domain);
      if (args.functionKey) pool = pool.filter((e) => e.functionKey === args.functionKey);
      if (args.maturity) pool = pool.filter((e) => e.maturity === args.maturity);
      if (typeof args.hasImpl === 'boolean') pool = pool.filter((e) => (e.implementations ?? []).length > 0 === args.hasImpl);

      const strict = pool
        .map((e) => ({ e, s: scoreOf(hay(e), tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || (b.e.year ?? 0) - (a.e.year ?? 0));

      let hits = strict;
      let loose = false;
      if (!hits.length) {
        loose = true;
        hits = pool
          .map((e) => ({ e, s: partialScore(hay(e), tokens) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || (b.e.year ?? 0) - (a.e.year ?? 0));
      }

      const head = [
        `# 天书检索：${q}`,
        `库内共 ${(payload.entries ?? []).length} 门术法 · 本次${loose ? '**放宽为部分匹配**（没有条目能同时命中所有关键词）' : '严格匹配'} · 命中 ${hits.length} 条，显示前 ${Math.min(limit, hits.length)} 条`,
        '',
      ].join('\n');
      if (!hits.length) {
        return `${head}\n库里没有相关术法。建议改用 tianji_ask（问天书，可联网找库外的新算法）。`;
      }
      const body = hits.slice(0, limit).map(({ e }) => card(e, tax())).join('\n\n');
      const more = hits.length > limit ? `\n\n（还有 ${hits.length - limit} 条，调大 limit 或加筛选条件）` : '';
      return `${head}\n${body}${more}`;
    },
  });

  ctx.tools.register({
    name: 'tianji_get',
    description: '按 id 取《天机阁 · 算法天书》里某门术法的完整档案：原理、取舍、评分、规格、现成实现链接、论文与来源、同法门其他方案。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '术法 id，如 gaussian-splatting-3dgs' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const payload = await store.load();
      const id = String(args.id ?? '').trim();
      const e = (payload.entries ?? []).find((x) => x.id === id);
      if (!e) {
        const near = (payload.entries ?? []).filter((x) => x.id.includes(id) || x.name.includes(id)).slice(0, 8).map((x) => x.id);
        throw new Error(`天书里没有 id=${id}${near.length ? `；相近的有：${near.join('、')}` : ''}`);
      }
      return card(e, tax(), { long: true });
    },
  });

  ctx.tools.register({
    name: 'tianji_ask',
    description: [
      '问天书：用一句自然语言描述你要做什么，AI 给出选型建议（先翻库内 196+ 门术法，可选再联网找库外的新算法与现成实现）。',
      '比 tianji_search 慢（库内约 5–15 秒；带联网约 20–40 秒），但能处理"我不知道该搜什么词"的需求。',
      'findNew=true 时会额外整理出可纳入天书的候选新术法，写进 data/pending/ 等人工核对。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '你要做的事，一句话。例："头发飘带想更自然，实时又要便宜"' },
        findNew: { type: 'boolean', description: '是否联网找库外的新算法（慢），默认 false 只翻库内' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const task = String(args.task ?? '').trim();
      if (!task) throw new Error('tianji_ask: task 不能为空');
      const aiPath = fileURLToPath(new URL('./lib/ai.mjs', import.meta.url));
      if (!existsSync(aiPath)) throw new Error(`找不到 ${aiPath}（问天书需要它）`);
      const ai = await import(pathToFileURL(aiPath).href);
      const payload = await store.load();
      const findNew = args.findNew === true;
      const t0 = Date.now();

      const lib = await ai.askLibrary(task, payload, { needQueries: findNew }).catch((err) => ({ answer: `（库内检索失败：${err.message}）`, picks: [], queries: [] }));
      const parts = [`# 问天书：${task}`, '', lib.answer || '（库内没有给出结论）'];

      if (lib.picks?.length) {
        parts.push('', `## 库内最相关的 ${lib.picks.length} 门`);
        for (const p of lib.picks) {
          const e = (payload.entries ?? []).find((x) => x.id === p.id);
          if (!e) continue;
          const impl = (e.implementations ?? [])[0];
          parts.push(`- **${e.name}**（\`${e.id}\`，${e.year ?? '—'}，${e.maturity}）—— ${p.why || e.summary || ''}${impl ? ` ｜ 现成：[${impl.name}](${impl.url})` : ''}`);
        }
      }

      if (findNew) {
        const queries = (lib.queries ?? []).slice(0, 3);
        parts.push('', `## 联网检索（${queries.length} 条检索式，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        for (const q of queries) parts.push(`- ${q}`);
        let sources = [];
        try {
          const results = await Promise.all(queries.map((q) => ai.webSearch(q, { maxUses: 2 }).catch(() => ({ sources: [] }))));
          const seen = new Set();
          for (const r of results) for (const s of r.sources ?? []) { if (!seen.has(s.url)) { seen.add(s.url); sources.push(s); } }
        } catch (err) {
          parts.push(`- （联网检索失败：${err.message}）`);
        }
        sources = sources.slice(0, 18);
        if (sources.length) {
          parts.push('', `### 找到 ${sources.length} 条来源`);
          for (const s of sources.slice(0, 12)) parts.push(`- ${s.title}${s.age ? ` (${s.age})` : ''} → ${link(s.url)}`);
        }
      }

      parts.push('', `（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 模型 ${ai.MODEL}）`);
      return parts.join('\n');
    },
  });

  ctx.tools.register({
    name: 'tianji_review',
    description: [
      '天书的复核队列：列出置信度不是 high、且还没被人工复核过的术法。',
      '每日采风用它挑 3–5 条核对，核对完用 tianji_review_mark 记账。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 15' },
        confidence: { type: 'string', description: '只看这个置信度：medium / low（缺省两者都看）' },
        domain: { type: 'string', description: '只看这一卷' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const payload = await store.load();
      const ledger = await readLedger(store);
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 15, 60);
      let pool = (payload.entries ?? []).filter((e) => e.confidence !== 'high' && !ledger[e.id]);
      if (args.confidence) pool = pool.filter((e) => e.confidence === args.confidence);
      if (args.domain) pool = pool.filter((e) => e.domain === args.domain);
      pool.sort((a, b) => String(a.confidence).localeCompare(String(b.confidence)) || (b.year ?? 0) - (a.year ?? 0));
      const total = (payload.entries ?? []).filter((e) => e.confidence !== 'high').length;
      if (!pool.length) return `# 复核队列\n\n没有待复核的术法（非 high 置信度共 ${total} 条，全部已复核或已被过滤条件排除）。`;
      const lines = [`# 复核队列（待复核 ${pool.length} 条 / 非 high 共 ${total} 条）`, ''];
      for (const e of pool.slice(0, limit)) {
        lines.push(`- **${e.name}**（\`${e.id}\`，${e.confidence}）—— ${e.summary ?? ''}`);
        if (e.caveats) lines.push(`  - 待核点：${e.caveats}`);
        const src = (e.sources ?? [])[0];
        if (src) lines.push(`  - 首要来源：${link(src.url)}`);
      }
      lines.push('', '核对完用 `tianji_review_mark`（或 `python tools/algohub.py review --mark <id> --status ok`）记账。');
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'tianji_review_mark',
    description: '给复核队列里的一条术法记账：ok（核对无误）/ fixed（已修正并补录）/ needswork（还要再查）。只写 data/review.json，不改天书正文。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '术法 id' },
        status: { type: 'string', description: 'ok / fixed / needswork' },
        note: { type: 'string', description: '一句话说明你核实了什么、改了什么' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const id = String(args.id ?? '').trim();
      const status = String(args.status ?? '').trim();
      if (!['ok', 'fixed', 'needswork'].includes(status)) throw new Error('status 只能是 ok / fixed / needswork');
      const payload = await store.load();
      if (!(payload.entries ?? []).some((e) => e.id === id)) throw new Error(`天书里没有 id=${id}`);
      const ledger = await readLedger(store);
      ledger[id] = { status, at: new Date().toISOString().slice(0, 10), note: String(args.note ?? '').trim() };
      const f = store.path('data', 'review.json');
      await mkdir(store.path('data'), { recursive: true });
      await writeFile(f, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
      return `已记账：${id} → ${status}${args.note ? `（${args.note}）` : ''}\n台账：${f}`;
    },
  });

  ctx.tools.register({
    name: 'tianji_stats',
    description: '天书体检：条目数、卷分布、多方案法门、有现成实现的比例、复核进度、覆盖矩阵状态、待核实区草稿数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const payload = await store.load();
      const entries = payload.entries ?? [];
      const ledger = await readLedger(store);
      const byDomain = new Map();
      for (const e of entries) byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);
      const fn = new Map();
      for (const e of entries) fn.set(e.functionKey, (fn.get(e.functionKey) ?? 0) + 1);
      const multi = [...fn.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
      const withImpl = entries.filter((e) => (e.implementations ?? []).length > 0).length;
      const implLinks = entries.reduce((n, e) => n + (e.implementations ?? []).length, 0);
      const conf = {};
      for (const e of entries) conf[e.confidence] = (conf[e.confidence] ?? 0) + 1;

      let pending = 0;
      try {
        const dir = store.path('data', 'pending');
        if (existsSync(dir)) {
          for (const f of await readdir(dir)) {
            if (!f.endsWith('.json')) continue;
            const d = JSON.parse(await readFile(join(dir, f), 'utf8'));
            pending += (d.entries ?? []).length;
          }
        }
      } catch { /* 待核实区坏了不影响体检 */ }

      let coverage = null;
      try { coverage = JSON.parse(await readFile(store.path('data', 'coverage.json'), 'utf8')); } catch { /* 还没采风过 */ }

      const out = [
        '# 天书体检',
        '',
        `- 术法 ${entries.length} 门 ｜ 法门 ${fn.size} 个（其中 ${multi.length} 个有多方案）`,
        `- 有现成法器 ${withImpl}/${entries.length} 条，共 ${implLinks} 个链接`,
        `- 置信度：high ${conf.high ?? 0} ｜ medium ${conf.medium ?? 0} ｜ low ${conf.low ?? 0}`,
        `- 复核台账：已复核 ${Object.keys(ledger).length} 条（待复核 ${entries.filter((e) => e.confidence !== 'high').length - Object.keys(ledger).length} 条）`,
        `- 待核实区：${pending} 条 AI 草稿（data/pending/）`,
        `- 数据更新时间：${payload.updatedAt ?? payload.generatedAt ?? '—'}`,
        '',
        '## 卷分布',
        ...(tax()?.domains ?? []).map((d) => `- ${d.scroll ? d.scroll + ' · ' : ''}${d.label}（${d.id}）：${byDomain.get(d.id) ?? 0}`),
      ];
      if (coverage?.domains && typeof coverage.domains === 'object') {
        const ids = Object.keys(coverage.domains);
        const cells = ids.reduce((n, id) => n + Object.keys(coverage.domains[id] ?? {}).length, 0);
        out.push('', `## 采风覆盖：${cells} 个（卷 × 视角）格子已记账，涉及 ${ids.length} 卷`);
        if (coverage.updatedAt) out.push(`- 最近记账：${coverage.updatedAt}`);
      }
      if (multi.length) {
        out.push('', '## 多方案法门（各有千秋，选型时看这些）');
        for (const [k, n] of multi.slice(0, 15)) {
          const label = entries.find((e) => e.functionKey === k)?.functionLabel ?? k;
          out.push(`- ${label}（\`${k}\`）：${n} 门`);
        }
      }
      return out.join('\n');
    },
  });

  ctx.tools.register({
    name: 'tianji_usage',
    description: [
      '天机阁的模型用量账本：看最近用了多少 token（按天/按类别）、看明细、删记录、设保留天数。',
      '每次「问天书」「采风」调用 AI 都会自动记一笔（prompt / completion / total tokens、联网检索次数、耗时）。',
      'action=read（默认）看账；delete 按 id 删；clear 清掉早于 N 天或全部；retention 设保留天数（默认 30 天，超期自动删）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'delete', 'clear', 'retention'], description: '默认 read' },
        days: { type: 'number', description: 'read 的统计窗口天数（默认 7）' },
        limit: { type: 'number', description: 'read 返回多少条明细（默认 20，最多 200）' },
        ids: { type: 'array', items: { type: 'string' }, description: 'action=delete 时要删的记录 id' },
        olderThanDays: { type: 'number', description: 'action=clear 时删掉早于这么多天的明细' },
        all: { type: 'boolean', description: 'action=clear 时删全部' },
        retentionDays: { type: 'number', description: 'action=retention 时的保留天数（1–3650）' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const mod = await usageLib();
      const action = String(args.action ?? 'read');
      if (action === 'read') {
        const s = await mod.summarizeUsage(dataDir, { days: Number(args.days) > 0 ? Number(args.days) : 7, limit: Math.min(200, Number(args.limit) > 0 ? Number(args.limit) : 20) });
        const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
        const lines = [
          '# 天机阁 · 模型用量',
          '',
          `- 近 ${s.window.days} 天：${s.window.calls} 次调用 ｜ ${k(s.window.totalTokens)} tokens（prompt ${k(s.window.promptTokens)} / completion ${k(s.window.completionTokens)}）｜ 联网检索 ${s.window.searches} 次`,
          `- 今天：${s.today.calls} 次 ｜ ${k(s.today.totalTokens)} tokens`,
          `- 累计（含已清理）：${s.lifetime.calls} 次 ｜ ${k(s.lifetime.totalTokens)} tokens ｜ 联网检索 ${s.lifetime.searches} 次`,
          `- 保留 ${s.retentionDays} 天${s.firstAt ? `，最早一条 ${s.firstAt}` : '（还没有记录）'}`,
        ];
        const byKind = Object.entries(s.window.byKind ?? {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
        if (byKind.length) {
          lines.push('', '## 按类别');
          for (const [kind, v] of byKind) lines.push(`- ${kind}：${v.calls} 次 ｜ ${k(v.totalTokens)} tokens ｜ 检索 ${v.searches} 次`);
        }
        if ((s.calls ?? []).length) {
          lines.push('', '## 最近明细');
          for (const c of s.calls.slice(0, 20)) {
            const t = String(c.at).replace('T', ' ').slice(0, 19);
            lines.push(`- ${t} ｜ ${c.kind} ｜ ${c.totalTokens} tokens${c.searches ? ` ｜ 检索 ${c.searches}` : ''}${c.ok === false ? ' ｜ 失败' : ''} ｜ ${c.label ?? ''} \`${c.id}\``);
          }
        }
        return lines.join('\n');
      }
      if (action === 'delete') {
        const r = await mod.clearUsage(dataDir, { ids: args.ids });
        return `删掉 ${r.removed} 条用量记录，剩 ${r.left} 条。`;
      }
      if (action === 'clear') {
        const r = await mod.clearUsage(dataDir, { olderThanDays: args.olderThanDays, all: args.all === true });
        return `清掉 ${r.removed} 条用量记录，剩 ${r.left} 条。`;
      }
      if (action === 'retention') {
        const r = await mod.setRetention(dataDir, args.retentionDays);
        return `保留天数设为 ${r.retentionDays} 天，这次顺手裁掉 ${r.removed} 条，剩 ${r.left} 条。`;
      }
      throw new Error(`tianji_usage: 不认识的 action=${action}`);
    },
  });

  ctx.tools.register({
    name: 'tianji_stage',
    description: [
      '往《天机阁 · 算法天书》里**新增**一条候选术法（写进 data/staging/plugin-<date>.json，待人工复核后 merge 入册，不会直接改主库）。',
      '用在"用户想收录某个新算法 / 让 AI 整理一条素材"的时候。字段要求见 tools/ENTRY-SCHEMA 与采风草稿：id（kebab-case）、name、domain（卷 id）、subdomain、functionKey、functionLabel、summary、howItWorks、maturity、year、tags、platforms、papers[]、implementations[]（name/url/type）、sources[]（title/url/kind，至少 1 条）、confidence。',
      'URL 必须是真实链接；不满足硬规则会被拒绝并给出原因。改已有条目请用 tianji_update。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'object', description: '完整条目对象（见 description 里的字段要求）' },
      },
      required: ['entry'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const mod = await entriesLib();
      const taxonomy = await loadTaxonomy();
      const r = await mod.stageEntry(dataDir, args.entry, taxonomy);
      return [
        `已写入候选素材：\`${r.id}\``,
        `- 文件：${r.file}（该文件现有 ${r.count} 条待复核）`,
        '',
        '下一步（人工/agent 都行）：',
        '1. `python tools/algohub.py validate` 看有没有格式问题',
        '2. `python tools/algohub.py merge` 合入主库',
        '3. `python tools/algohub.py export` + `node tools/embed-library.mjs` 让页面和离线快照跟上',
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: 'tianji_update',
    description: [
      '就地修改《天机阁 · 算法天书》里**已存在**的一条素材（名称、摘要、原理、取舍、标签、实现链接、论文、来源、成熟度、年份、置信度、注意事项、别名、相关 id）。',
      '写盘前自动备份到 data/backups/，校验不过不写；改不了 id / domain / functionKey（索引键，要改请走 staging + merge）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的条目 id，如 gaussian-splatting-3dgs' },
        patch: { type: 'object', description: '要覆盖的字段（只写要改的，值整体替换）' },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const mod = await entriesLib();
      const taxonomy = await loadTaxonomy();
      const r = await mod.updateEntry(dataDir, args.id, args.patch, taxonomy);
      return [
        `已更新：\`${r.id}\``,
        `- 改动字段：${r.changed.length ? r.changed.join('、') : '（值没变，只刷新了 lastChecked）'}`,
        `- 备份：${r.backup}`,
        `- 主库现有 ${r.total} 条`,
        '',
        '记得跑 `python tools/algohub.py validate` 复核，再 `export` + `node tools/embed-library.mjs` 让页面看到。',
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: 'tianji_sweep',
    description: [
      '触发/查看「采风」（联网找库外新算法 → 模型整理成候选草稿 → 写 data/pending/，人工复核后入册）。',
      'action=status（默认）看当前或上一轮进度、上次自动采风时间、开关与最短间隔；',
      'action=start 开跑一轮（自动触发会先过"开关 + 最短间隔"，没到点会被拒绝并告知下次可跑时间）；',
      'action=config 改自动采风的开关与最短间隔（auto: true/false，minIntervalHours: 0-720，0=不限制）。',
      '自动触发的时间记在 data/sweep-state.json，开关与间隔记在 data/sweep-config.json。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'config'], description: '默认 status' },
        domains: { type: 'array', items: { type: 'string' }, description: '只采这几卷（卷 id，如 rendering / animation），不传则全部 13 卷' },
        angles: { type: 'array', items: { type: 'string' }, description: '采风角度：new / classic / impl / compare，默认 new' },
        auto: { type: 'boolean', description: 'action=config 时用：是否允许自动采风' },
        minIntervalHours: { type: 'integer', description: 'action=config 时用：最短间隔小时数，0 = 不限制' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const mod = await sweep();
      const action = String(args.action ?? 'status');
      const state = await mod.readSweepState(dataDir);
      const gap = mod.describeSweepGap(state);

      if (action === 'config') {
        const patch = {};
        if (typeof args.auto === 'boolean') patch.auto = args.auto;
        if (Number.isFinite(Number(args.minIntervalHours))) patch.minIntervalHours = Number(args.minIntervalHours);
        const config = Object.keys(patch).length ? await mod.writeConfig(dataDir, patch) : await mod.readConfig(dataDir);
        const check = mod.checkAutoEligible(config, state);
        return [
          '# 自动采风设置',
          '',
          `- 开关：${config.auto ? '已打开' : '已关闭'}`,
          `- 最短间隔：${config.minIntervalHours === 0 ? '不限制' : `${config.minIntervalHours} 小时`}`,
          `- 现在能不能自动跑：${check.allowed ? '可以' : `不行 —— ${check.reason}`}`,
          `- ${gap.text}`,
        ].join('\n');
      }

      if (action === 'start') {
        const started = await mod.startSweep(dataDir, { domains: args.domains, angles: args.angles, trigger: 'agent' });
        if (started.refused) {
          return `这轮按设置没跑：\n- ${started.reason}${started.nextAt ? `\n- 下次可自动跑：${started.nextAt}` : ''}\n\n想立刻就采，用页面「立即采风」按钮（手动不受间隔限制），或先把最短间隔调小。`;
        }
        const head = started.alreadyRunning ? '已经有一轮在跑，没有重复开：' : '开跑了：';
        return `${head}\n- 任务 ${started.id}（${started.state}），${started.cells?.length ?? 0} 格\n- 上次采风：${gap.text}\n\n用 action=status 看进度；跑完草稿在 data/pending/。`;
      }
      const job = mod.getJob();
      const config = await mod.readConfig(dataDir);
      const check = mod.checkAutoEligible(config, state);
      const lines = [`# 采风状态`, '', `- ${gap.text}`];
      lines.push(`- 自动采风：${config.auto ? '开' : '关'} ｜ 最短间隔 ${config.minIntervalHours === 0 ? '不限制' : `${config.minIntervalHours} 小时`} ｜ ${check.allowed ? '现在可跑' : check.reason}`);
      if (!job) {
        lines.push('- 当前没有任务（也从没在这个进程里跑过）');
      } else {
        lines.push(`- 任务 ${job.id}：${job.state}${job.finishedAt ? `，收工于 ${job.finishedAt}` : `，开始于 ${job.startedAt}`}`);
        const done = (job.cells ?? []).filter((c) => c.state === 'done').length;
        lines.push(`- 进度：${done}/${job.cells?.length ?? 0} 格完成 ｜ 来源 ${job.totals?.found ?? 0} 条 ｜ 草稿 ${job.totals?.drafts ?? 0} 条 ｜ 失败 ${job.totals?.failed ?? 0} 格`);
        for (const c of job.cells ?? []) lines.push(`  - ${c.domainLabel}·${c.angle}：${c.state}${c.note ? `（${c.note}）` : ''}${c.drafts ? ` 草稿 ${c.drafts}` : ''}`);
      }
      return lines.join('\n');
    },
  });
}

/* ------------------------------------------------------------------ 台账 */

async function readLedger(store) {
  try {
    return JSON.parse(await readFile(store.path('data', 'review.json'), 'utf8'));
  } catch {
    return {};
  }
}
