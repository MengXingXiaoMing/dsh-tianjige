/**
 * 采风引擎（宿主侧）——给侧栏页面「采风」「问天书」两个标签页供数据与动作。
 *
 * 只依赖 node 内置和 ./ai.mjs，不 import 任何 Harness 包；宿主用动态 import 加载它，
 * 这样 apply() 不因为网络/模型模块出问题而整体失败。
 *
 * 一轮「采风」= 对若干卷各跑一格：联网检索 → 模型整理成候选草稿 → 清洗 → 落 data/pending/，
 * 同时更新 data/coverage.json（覆盖矩阵）与 data/runs/ai-sweep-<date>.json（轮次台账）。
 * 草稿不会直接进主库——人工用 tianji_merge 或 CLI merge 复核后才入册。
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as ai from './ai.mjs';
import * as usage from './usage.mjs';

/* ------------------------------------------------------------------ 常量 */

/** 采风角度（与 taxonomy.axes 对应）。 */
const ANGLES = ['new', 'classic', 'impl', 'compare'];

/** 每个格子最多产出的草稿数。 */
const CELL_DRAFTS = 2;

/** 单格超时：联网检索 + 模型整理都在里面。 */
const CELL_TIMEOUT_MS = 150_000;

/** 每个格子最多用几条检索式、最多留多少条来源。 */
const QUERIES_PER_CELL = 2;
const MAX_SOURCES = 12;

/** 复核结论（与 tools/algohub.py review 一致）。 */
const REVIEW_STATUS = ['ok', 'fixed', 'needswork'];

/* ------------------------------------------------------------ 基础小工具 */

const pad = (n) => String(n).padStart(2, '0');
const nowIso = () => new Date().toISOString();

/** 本机时区的 YYYY-MM-DD（宿主就在用户机器上，按本地日期记账）。 */
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

const rejectAfter = (ms, label) =>
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
    if (typeof t.unref === 'function') t.unref();
  });

/** 把 N 次检索的来源合起来：按 url 去重，保留前 MAX_SOURCES 条。 */
function mergeSources(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    for (const s of r?.sources ?? []) {
      if (!s?.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push({ title: String(s.title ?? s.url).slice(0, 180), url: s.url, age: s.age ?? undefined, snippet: s.snippet ?? undefined });
      if (out.length >= MAX_SOURCES) return out;
    }
  }
  return out;
}

/* -------------------------------------------------------- 采风时间台账 */

/** 每日采风的期望节奏（小时）。每日卡片是 09:30，一天一次。 */
export const SWEEP_CADENCE_HOURS = 24;

const SWEEP_STATE_FILE = 'sweep-state.json';
const sweepStatePath = (baseDir) => join(baseDir, 'data', SWEEP_STATE_FILE);

/** 读采风时间台账（不存在就返回空台账，不回填历史）。
 *
 * 插件自己跑的会在 `sweep-state.json` 记账；Agent/CLI 跑的只写 `data/runs/*.json`。
 * 两边都看、取更晚的那个 —— 否则页面上会把「明明昨天跑过」报成漏采。 */
export async function readSweepState(baseDir) {
  const raw = (await readJson(sweepStatePath(baseDir), null)) ?? {};
  let derivedAt = null;
  for (const f of await listJson(join(baseDir, 'data', 'runs'))) {
    if (/^plan-/.test(f)) continue; // plan-* 是「今天打算搜什么」，不是真跑过
    const d = await readJson(join(baseDir, 'data', 'runs', f), null);
    const at = d?.updatedAt ?? d?.generatedAt ?? d?.at ?? null;
    if (at && Number.isFinite(Date.parse(at)) && (!derivedAt || Date.parse(at) > Date.parse(derivedAt))) derivedAt = at;
  }
  return {
    version: 1,
    lastSweepAt: raw.lastSweepAt ?? derivedAt,
    lastAutoSweepAt: raw.lastAutoSweepAt ?? null,
    derivedAt,
    lastKind: raw.lastKind ?? null,
    running: raw.running ?? null,
    /* 每卷的「查到第几层」：used 记已经用过的检索式，runs 记跑过几轮 */
    cursor: raw.cursor && typeof raw.cursor === 'object' ? raw.cursor : {},
    history: Array.isArray(raw.history) ? raw.history.slice(0, 60) : [],
  };
}

/* ------------------------------------------------------------ 往深处走 */

/**
 * 每卷一池检索式：计划里的 + 按卷名/年份生成的变体。
 * 不调模型，纯字符串拼，保证池子比「一轮 2 条」大得多，轮换才有意义。
 */
function queryPool(domainLabel, planned) {
  const year = new Date().getFullYear();
  const base = [...new Set((planned ?? []).map((q) => String(q).trim()).filter(Boolean))];
  const variants = [
    `${domainLabel} ${year} 新算法 论文`,
    `${domainLabel} ${year} 开源仓库 实现`,
    `${domainLabel} ${year - 1} ${year} 新方法 综述`,
    `${domainLabel} 经典算法 对比 优缺点`,
  ];
  return [...new Set([...base, ...variants])];
}

/** 挑这一轮要查的：优先没查过的，池子轮完了再从头转。 */
function pickQueries(pool, usedList) {
  const used = new Set(usedList ?? []);
  const fresh = pool.filter((q) => !used.has(q));
  const picked = fresh.slice(0, QUERIES_PER_CELL);
  for (const q of pool) {
    if (picked.length >= QUERIES_PER_CELL) break;
    if (!picked.includes(q)) picked.push(q);
  }
  return { picked: picked.slice(0, QUERIES_PER_CELL), exhausted: fresh.length === 0 };
}

/** 条目标题归一：去空白/标点/大小写，用来判重。 */
function normName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・:：,，.。!！?？'"“”‘’()（）\[\]【】\-_/\\|]/g, '');
}

/**
 * 草稿去重：主库已有的、待核实区已有的、同一批里重复的，都不再写进去。
 * 判重看「归一化标题」和「同卷同法门同名」两条。
 */
async function dedupeDrafts(baseDir, drafts) {
  const data = join(baseDir, 'data');
  const lib = (await readJson(join(data, 'algorithms.json'), { entries: [] }))?.entries ?? [];
  const names = new Set(lib.map((e) => normName(e.name)));
  const ids = new Set(lib.map((e) => e.id));
  const keys = new Set(lib.map((e) => `${e.domain}|${e.functionKey}|${normName(e.name)}`));
  for (const f of await listJson(join(data, 'pending'))) {
    const doc = await readJson(join(data, 'pending', f), null);
    for (const e of doc?.entries ?? []) {
      names.add(normName(e.name));
      ids.add(e.id);
      keys.add(`${e.domain}|${e.functionKey}|${normName(e.name)}`);
    }
  }
  const kept = [];
  const dropped = [];
  for (const d of drafts) {
    const n = normName(d.name);
    const key = `${d.domain}|${d.functionKey}|${n}`;
    if (!n || ids.has(d.id) || names.has(n) || keys.has(key)) {
      dropped.push({ draft: d, why: ids.has(d.id) ? 'id 已存在' : names.has(n) ? '同名条目已在库里' : '同卷同法门同名' });
      continue;
    }
    ids.add(d.id);
    names.add(n);
    keys.add(key);
    kept.push(d);
  }
  return { kept, dropped };
}

async function patchSweepState(baseDir, patch) {
  const state = await readSweepState(baseDir);
  const next = { ...state, ...patch };
  next.updatedAt = nowIso();
  await writeJson(sweepStatePath(baseDir), next);
  return next;
}

/**
 * 距上次"自动联网采风"过了多久、漏了几天。
 * 漏采天数 = floor((now - lastAutoSweepAt) / 24h) - 1，最少 0：
 * 24h 内算准时，48h 算漏 1 天，72h 算漏 2 天。
 */
export function describeSweepGap(state, now = Date.now()) {
  const auto = Boolean(state?.lastAutoSweepAt);
  const last = state?.lastAutoSweepAt ?? state?.lastSweepAt ?? null;
  const t = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(t)) {
    return {
      lastAutoSweepAt: null,
      lastSweepAt: state?.lastSweepAt ?? null,
      hoursAgo: null,
      missedDays: null,
      cadenceHours: SWEEP_CADENCE_HOURS,
      warning: false,
      stale: true,
      text: '还没有采风记录（从这次之后开始记）',
    };
  }
  const hoursAgo = Math.max(0, (now - t) / 3_600_000);
  const missedDays = Math.max(0, Math.floor(hoursAgo / SWEEP_CADENCE_HOURS) - 1);
  const h = Math.round(hoursAgo);
  const hText = hoursAgo < 1 ? '不到 1 小时' : `${h} 小时`;
  const what = auto ? '自动采风' : '上次采风（手动/Agent 记的）';
  const text =
    missedDays > 0
      ? `距${what} ${hText}，可能漏了 ${missedDays} 天没查`
      : `距${what} ${hText}（${hoursAgo < SWEEP_CADENCE_HOURS ? '在节奏内' : '快一天了，记得跑'}）`;
  return {
    lastAutoSweepAt: state?.lastAutoSweepAt ?? null,
    lastSweepAt: state?.lastSweepAt ?? null,
    auto,
    hoursAgo: Math.round(hoursAgo * 10) / 10,
    missedDays,
    cadenceHours: SWEEP_CADENCE_HOURS,
    warning: missedDays > 0,
    stale: false,
    text,
  };
}

/* ------------------------------------------------------- 自动采风配置 */

/** 自动采风的开关与最短间隔（小时）。0 = 不限制。 */
export const SWEEP_CONFIG_FILE = 'sweep-config.json';
export const MIN_INTERVAL_RANGE = [0, 720];
export const DEFAULT_CONFIG = { auto: true, minIntervalHours: SWEEP_CADENCE_HOURS };

const sweepConfigPath = (baseDir) => join(baseDir, 'data', SWEEP_CONFIG_FILE);

/** 只认整数，越界就往边界上夹。 */
function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    auto: src.auto !== false,
    minIntervalHours: clampInt(src.minIntervalHours, MIN_INTERVAL_RANGE[0], MIN_INTERVAL_RANGE[1], DEFAULT_CONFIG.minIntervalHours),
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : null,
  };
}

export async function readConfig(baseDir) {
  return normalizeConfig(await readJson(sweepConfigPath(baseDir), null));
}

export async function writeConfig(baseDir, patch) {
  const cur = await readConfig(baseDir);
  const next = normalizeConfig({ ...cur, ...(patch ?? {}), updatedAt: nowIso() });
  await writeJson(sweepConfigPath(baseDir), next);
  return next;
}

/**
 * 现在这一轮「自动采风」该不该跑。
 * 关掉 → 不跑；没到最短间隔 → 不跑；从没跑过 → 立刻可以跑。
 * 手动按钮不受这个约束（用户亲手点的，就得干）。
 */
export function checkAutoEligible(config, state, now = Date.now()) {
  const cfg = normalizeConfig(config);
  const last = state?.lastSweepAt ?? state?.lastAutoSweepAt ?? null;
  const t = last ? Date.parse(last) : NaN;
  const hoursAgo = Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : null;
  const base = {
    enabled: cfg.auto,
    minIntervalHours: cfg.minIntervalHours,
    lastSweepAt: last,
    hoursAgo: hoursAgo === null ? null : Math.round(hoursAgo * 10) / 10,
    nextAt: null,
  };
  if (!cfg.auto) {
    return { ...base, allowed: false, reason: '自动采风已关闭（页面上可随时打开；手动「立即采风」不受影响）' };
  }
  if (hoursAgo !== null && cfg.minIntervalHours > 0 && hoursAgo < cfg.minIntervalHours) {
    const nextAt = new Date(t + cfg.minIntervalHours * 3_600_000).toISOString();
    return {
      ...base,
      allowed: false,
      nextAt,
      reason: `距上次采风 ${Math.round(hoursAgo)} 小时，还没到最短间隔 ${cfg.minIntervalHours} 小时（${nextAt.slice(0, 16).replace('T', ' ')} 之后才允许自动跑）`,
    };
  }
  return { ...base, allowed: true, reason: '可以跑' };
}

/* ------------------------------------------------------------ 采风状态 */

/**
 * 页面「采风」标签页要的全量状态：卷清单、覆盖矩阵、今日进度、最近轮次、
 * 待核实草稿、复核队列、密钥状态。一次请求全给，页面自己渲染。
 */
export async function readMeta(baseDir) {
  const data = join(baseDir, 'data');
  const [tax, algos, cov, rev, runFiles, pendingFiles, stagingFiles, snapshotFiles] = await Promise.all([
    readJson(join(data, 'taxonomy.json'), null),
    readJson(join(data, 'algorithms.json'), { entries: [] }),
    readJson(join(data, 'coverage.json'), { domains: {} }),
    readJson(join(data, 'review.json'), {}),
    listJson(join(data, 'runs')),
    listJson(join(data, 'pending')),
    listJson(join(data, 'staging')),
    listJson(join(data, 'snapshots')),
  ]);

  const today = dateStr();
  const entries = algos?.entries ?? [];
  const byDomain = new Map();
  for (const e of entries) byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);

  const domains = (tax?.domains ?? []).map((d) => ({
    id: d.id,
    label: d.label ?? d.id,
    accent: d.accent ?? null,
    subdomains: (d.subdomains ?? []).length,
    entries: byDomain.get(d.id) ?? 0,
  }));

  /* 轮次台账：plan-<date>.json 是检索计划，seed-<date>.json / ai-sweep-<date>.json 是实跑 */
  const runDocs = [];
  for (const f of runFiles) {
    const doc = await readJson(join(data, 'runs', f), null);
    if (!doc) continue;
    runDocs.push({ file: f, doc });
  }
  const planDoc = [...runDocs].filter((r) => r.file.startsWith('plan-')).sort((a, b) => b.file.localeCompare(a.file))[0]?.doc ?? null;
  const actual = runDocs
    .filter((r) => !r.file.startsWith('plan-'))
    .map(({ file, doc }) => ({
      file,
      date: String(doc.date ?? file.replace(/\D+/g, '-').slice(0, 10)),
      note: String(doc.note ?? '').slice(0, 200),
      kind: file.startsWith('ai-sweep-') ? 'ai' : 'agent',
      cells: (doc.results ?? []).length,
      found: (doc.results ?? []).reduce((n, r) => n + (Number(r.found) || 0), 0),
      newEntries: (doc.results ?? []).reduce((n, r) => n + (Number(r.newEntries) || 0), 0),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.file.localeCompare(a.file));

  /* 今日格子进度：以计划里的格子总数为分母 */
  const planCells = (planDoc?.sweep ?? []).map((c) => ({
    domain: c.domain,
    domainLabel: c.domainLabel ?? c.domain,
    angle: c.angle ?? 'new',
    angleLabel: c.angleLabel ?? ANGLES.includes(c.angle) ? c.angle : '新法',
    queries: Array.isArray(c.queries) ? c.queries.slice(0, 4) : [],
  }));
  const todayRun = runDocs.find((r) => r.file === `ai-sweep-${today}.json`)?.doc ?? null;
  const todayDone = new Set((todayRun?.results ?? []).map((r) => `${r.domain}:${r.angle}`));
  const todayCells = {
    done: todayDone.size,
    total: planCells.length || domains.length,
    planDate: planDoc?.date ?? null,
  };

  /* 待核实草稿：把 pending/*.json 里所有条目摊平（含来源文件，便于回溯） */
  const pending = [];
  for (const f of pendingFiles) {
    const doc = await readJson(join(data, 'pending', f), null);
    for (const e of doc?.entries ?? []) {
      pending.push({
        id: e.id,
        name: e.name ?? e.id,
        domain: e.domain,
        subdomain: e.subdomain,
        maturity: e.maturity,
        confidence: e.confidence ?? 'medium',
        summary: String(e.summary ?? '').slice(0, 240),
        year: e.year,
        file: f,
        agent: doc?.agent ?? 'unknown',
        generatedAt: doc?.generatedAt ?? null,
      });
    }
  }
  pending.sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')) || String(a.id).localeCompare(String(b.id)));

  /* 复核队列：非 high 且没记过账的术法 */
  const ledger = rev ?? {};
  const queue = entries
    .filter((e) => e.confidence !== 'high' && !ledger[e.id])
    .map((e) => ({
      id: e.id,
      name: e.name ?? e.id,
      domain: e.domain,
      maturity: e.maturity,
      confidence: e.confidence ?? 'medium',
      year: e.year,
      summary: String(e.summary ?? '').slice(0, 220),
    }))
    .sort((a, b) => String(a.domain).localeCompare(String(b.domain)) || String(a.id).localeCompare(String(b.id)));

  let key = { present: false, from: 'unknown' };
  try {
    key = await ai.keyStatus();
  } catch (err) {
    key = { present: false, from: `error: ${String(err?.message ?? err)}` };
  }

  const sweepState = await readSweepState(baseDir);
  const config = await readConfig(baseDir);

  return {
    at: nowIso(),
    today,
    model: ai.MODEL,
    key,
    domains,
    counts: {
      total: entries.length,
      pending: pending.length,
      reviewQueue: queue.length,
      reviewed: Object.keys(ledger).length,
      stagingFiles: stagingFiles.length,
      snapshots: snapshotFiles.length,
    },
    plan: planDoc ? { date: planDoc.date, generatedAt: planDoc.generatedAt, rule: planDoc.rule, searchBudget: planDoc.searchBudget, cells: planCells } : null,
    todayCells,
    coverage: cov?.domains ?? {},
    runs: actual.slice(0, 8),
    lastRun: actual[0] ?? null,
    pending,
    review: { queue, ledger },
    angles: ANGLES.map((a) => ({ id: a, label: { new: '新法', classic: '经典', impl: '实现', compare: '对比' }[a] })),
    sweep: describeSweepGap(sweepState),
    config,
    autoCheck: checkAutoEligible(config, sweepState),
    usage: await usage.summarizeUsage(baseDir, { days: 7, limit: 20 }).catch(() => null),
    job: getJob(),
  };
}

/* ------------------------------------------------------------ 采风任务 */

/** 当前（或最近一次）采风任务；同一时刻只允许跑一轮。 */
let job = null;

export function getJob() {
  return job;
}

/**
 * 起一轮采风。已经有一轮在跑就直接把现场返回（不叠加）。
 * @param {string} baseDir 项目根（含 data/）
 * @param {{domains?: string[]|null, angles?: string[], budgetMs?: number}} opts
 */
export async function startSweep(baseDir, opts = {}) {
  if (job && job.state === 'running') return { ...job, alreadyRunning: true };

  /* 自动触发（每日卡片 / 定时）先过「开关 + 最短间隔」两道闸；
     手动按「立即采风」不受限 —— 用户亲手点的，就得干。 */
  const config = await readConfig(baseDir);
  const autoTrigger = opts.trigger === 'agent' || opts.trigger === 'auto';
  if (autoTrigger) {
    const check = checkAutoEligible(config, await readSweepState(baseDir));
    if (!check.allowed) {
      return { state: 'refused', refused: true, reason: check.reason, nextAt: check.nextAt, check, config };
    }
  }

  const meta0 = await readMeta(baseDir);
  const wanted = Array.isArray(opts.domains) && opts.domains.length ? new Set(opts.domains) : null;
  const angles = (Array.isArray(opts.angles) && opts.angles.length ? opts.angles : ['new']).filter((a) => ANGLES.includes(a));
  const planByDomain = new Map();
  for (const c of meta0.plan?.cells ?? []) {
    const list = planByDomain.get(c.domain) ?? [];
    list.push(...c.queries);
    planByDomain.set(c.domain, list);
  }

  const cells = [];
  const state0 = await readSweepState(baseDir);
  const cursor0 = state0.cursor ?? {};
  for (const d of meta0.domains) {
    if (wanted && !wanted.has(d.id)) continue;
    const cur = cursor0[d.id] ?? {};
    const pool = queryPool(d.label, planByDomain.get(d.id) ?? []);
    for (const angle of angles) {
      const { picked, exhausted } = pickQueries(pool, cur.used ?? []);
      cells.push({
        domain: d.id,
        domainLabel: d.label,
        angle,
        state: 'pending',
        queries: picked,
        poolSize: pool.length,
        depth: (Number(cur.runs) || 0) + 1,
        exhausted,
        found: 0,
        drafts: 0,
        dropped: 0,
        error: null,
        ms: 0,
        note: '',
      });
    }
  }

  job = {
    id: `sweep-${Date.now()}`,
    startedAt: nowIso(),
    finishedAt: null,
    state: 'running',
    trigger: opts.trigger === 'agent' ? 'agent' : 'plugin',
    minIntervalHours: config.minIntervalHours,
    budgetMs: Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 900_000,
    cells,
    totals: { found: 0, drafts: 0, dropped: 0, failed: 0 },
    log: [{ at: nowIso(), msg: `开跑：${cells.length} 格（${angles.join(' / ')}）× ${cells.length} 卷` }],
  };

  /* 记下"这一刻开始查了"，采风中途崩掉也能看出时间断档 */
  await patchSweepState(baseDir, {
    running: { id: job.id, startedAt: job.startedAt, kind: job.trigger, cells: cells.length },
  }).catch(() => {});

  runJob(baseDir, job).catch(async (err) => {
    job.state = 'failed';
    job.error = String(err?.message ?? err);
    job.finishedAt = nowIso();
    job.log.push({ at: nowIso(), msg: `整轮失败：${job.error}` });
    await finishSweepState(baseDir, job);
  });

  return job;
}

function ctxOf(meta, entries) {
  const ids = new Set((entries ?? []).map((e) => e.id));
  const byDomain = new Map();
  for (const e of entries ?? []) {
    const list = byDomain.get(e.domain) ?? [];
    if (list.length < 24) list.push(`${e.id}（${e.name}）`);
    byDomain.set(e.domain, list);
  }
  return {
    tax: meta.taxonomyCache ?? null,
    ids,
    knownOf: (domain) => (byDomain.get(domain) ?? []).join('、') || '（这一卷还没有条目）',
  };
}

async function runJob(baseDir, j) {
  const t0 = Date.now();
  /* 一次读齐：分类法、条目 id 集合、同卷已有条目名（喂给模型避免重复产出） */
  const [tax, algos] = await Promise.all([readJson(join(baseDir, 'data', 'taxonomy.json'), { domains: [] }), readJson(join(baseDir, 'data', 'algorithms.json'), { entries: [] })]);
  const entries = algos?.entries ?? [];
  const ids = new Set(entries.map((e) => e.id));
  const byDomain = new Map();
  for (const e of entries) {
    const list = byDomain.get(e.domain) ?? [];
    if (list.length < 24) list.push(`${e.id}（${e.name}）`);
    byDomain.set(e.domain, list);
  }
  const knownOf = (domain) => (byDomain.get(domain) ?? []).join('、') || '（这一卷还没有条目）';

  for (const cell of j.cells) {
    if (Date.now() - t0 > j.budgetMs) {
      cell.state = 'dead';
      cell.note = '超出整轮预算，未跑';
      j.log.push({ at: nowIso(), msg: `${cell.domainLabel} 跳过：超出整轮预算` });
      continue;
    }
    const cellT0 = Date.now();
    try {
      await Promise.race([runCell(cell, { tax, ids, knownOf, baseDir }), rejectAfter(CELL_TIMEOUT_MS, `${cell.domainLabel} 采风`)]);

      /* 落盘：轮次台账 + 覆盖矩阵 + 待核实草稿 */
      await recordCell(baseDir, cell);
      cell.ms = Date.now() - cellT0;
      j.totals.found += cell.found;
      j.totals.drafts += cell.drafts;
      j.totals.dropped += cell.dropped;
      j.log.push({ at: nowIso(), msg: `${cell.domainLabel}：来源 ${cell.found} 条 → 草稿 ${cell.drafts} 条${cell.dropped ? `（丢弃 ${cell.dropped}）` : ''}` });
    } catch (err) {
      cell.state = 'failed';
      cell.error = String(err?.message ?? err);
      cell.ms = Date.now() - cellT0;
      j.totals.failed += 1;
      j.log.push({ at: nowIso(), msg: `${cell.domainLabel} 失败：${cell.error}` });
      /* 失败也记一次台账，覆盖矩阵里留下痕迹（found=0） */
      await recordCell(baseDir, cell).catch(() => {});
    }
  }

  j.state = j.totals.failed === j.cells.length && j.cells.length > 0 ? 'failed' : 'done';
  j.finishedAt = nowIso();
  j.ms = Date.now() - t0;
  j.log.push({ at: nowIso(), msg: `收工：${j.cells.length} 格，来源 ${j.totals.found} 条，草稿 ${j.totals.drafts} 条，失败 ${j.totals.failed} 格` });
  await finishSweepState(baseDir, j);
}

/** 一轮结束（成功或失败）都记：上次自动采风时间 + 历史一条。 */
async function finishSweepState(baseDir, j) {
  try {
    const state = await readSweepState(baseDir);
    const at = j.finishedAt ?? nowIso();
    const entry = {
      id: j.id,
      at,
      kind: j.trigger ?? 'plugin',
      state: j.state,
      cells: j.cells?.length ?? 0,
      found: j.totals?.found ?? 0,
      drafts: j.totals?.drafts ?? 0,
      failed: j.totals?.failed ?? 0,
      domains: [...new Set((j.cells ?? []).map((c) => c.domain))],
      angles: [...new Set((j.cells ?? []).map((c) => c.angle))],
    };
    await writeJson(sweepStatePath(baseDir), {
      version: 1,
      lastSweepAt: at,
      lastAutoSweepAt: at,
      lastKind: entry.kind,
      running: null,
      updatedAt: nowIso(),
      history: [entry, ...state.history].slice(0, 60),
    });
  } catch {
    /* 记时间失败不能影响采风结果 */
  }
}

/** 单格：联网检索 → 模型整理 → 清洗。结果写回 cell（每次 AI 调用都记进 token 账本）。 */
async function runCell(cell, ctx) {
  cell.state = 'searching';
  const queries = cell.queries.slice(0, QUERIES_PER_CELL);
  const tSearch = Date.now();
  const results = await Promise.all(
    queries.map((q) =>
      ai
        .webSearch(q, { maxUses: 2 })
        .then((r) => ({ ...r, ok: true }))
        .catch((err) => ({ sources: [], ok: false, error: err })),
    ),
  );

  /* 记账：每条检索式一笔（失败也记，带错误原因） */
  if (ctx.baseDir) {
    const per = Math.round((Date.now() - tSearch) / Math.max(1, results.length));
    await Promise.all(
      results.map((r, i) =>
        usage
          .recordUsage(ctx.baseDir, {
            kind: 'sweep-search',
            model: ai.SEARCH_MODEL,
            label: queries[i],
            domain: cell.domain,
            usage: r.usage,
            elapsedMs: per,
            ok: r.ok !== false,
            error: r.error?.message,
          })
          .catch(() => {}),
      ),
    );
  }

  const sources = mergeSources(results);
  cell.found = sources.length;

  if (!sources.length) {
    cell.state = 'done';
    cell.note = '没搜到来源，跳过整理';
    return;
  }

  cell.state = 'drafting';
  const question = `为「${cell.domainLabel}」卷找 2026 年新出现/值得收录的算法或技术（角度：${cell.angle === 'new' ? '新法·新论文/新仓库' : cell.angle}）。找到的必须能落到这一卷里，且与库内已有条目不重复。`;
  const tDraft = Date.now();
  const drafted = await ai.proposeDrafts({
    question,
    sources,
    knownIndex: ctx.knownOf(cell.domain),
    tax: ctx.tax,
    maxDrafts: CELL_DRAFTS,
  });
  const drafts = drafted.drafts ?? [];
  if (ctx.baseDir) {
    await usage
      .recordUsage(ctx.baseDir, {
        kind: 'sweep-draft',
        model: ai.MODEL,
        label: `${cell.domainLabel} · ${cell.angle} 草稿整理（来源 ${sources.length} 条）`,
        domain: cell.domain,
        usage: drafted.usage,
        elapsedMs: Date.now() - tDraft,
        ok: true,
      })
      .catch(() => {});
  }
  const { kept, dropped } = ai.sanitizeDrafts(drafts, ctx.tax, ctx.ids);
  for (const k of kept) ctx.ids.add(k.id);
  cell.drafts = kept.length;
  cell.dropped = dropped.length;
  cell.kept = kept;
  cell.state = 'done';
}

/** 把一格的战果落盘：runs/ai-sweep-<date>.json、coverage.json、pending/ai-<date>.json。 */
async function recordCell(baseDir, cell) {
  const data = join(baseDir, 'data');
  const today = dateStr();
  const kept = cell.kept ?? [];

  /* 1) 轮次台账 */
  const runPath = join(data, 'runs', `ai-sweep-${today}.json`);
  const run = (await readJson(runPath, null)) ?? { date: today, note: '插件界面自动采风（模型整理，待人工复核）', results: [] };
  run.results = (run.results ?? [])
    .filter((r) => !(r.domain === cell.domain && r.angle === cell.angle))
    .concat([
      {
        domain: cell.domain,
        angle: cell.angle,
        found: cell.found,
        newEntries: kept.length,
        queries: cell.queries,
        note: cell.error ? `失败：${cell.error}` : cell.note || `草稿 ${kept.length} 条`,
        by: 'plugin',
      },
    ]);
  run.updatedAt = nowIso();
  await writeJson(runPath, run);

  /* 2) 覆盖矩阵 */
  const covPath = join(data, 'coverage.json');
  const cov = (await readJson(covPath, null)) ?? { domains: {} };
  cov.domains = cov.domains ?? {};
  cov.domains[cell.domain] = cov.domains[cell.domain] ?? {};
  const bucket = (cov.domains[cell.domain][cell.angle] = cov.domains[cell.domain][cell.angle] ?? { runs: 0, found: 0, newEntries: 0 });
  bucket.runs = (Number(bucket.runs) || 0) + 1;
  bucket.found = (Number(bucket.found) || 0) + cell.found;
  bucket.newEntries = (Number(bucket.newEntries) || 0) + kept.length;
  bucket.lastRun = today;
  bucket.lastQueries = cell.queries;
  cov.updatedAt = nowIso();
  await writeJson(covPath, cov);

  /* 3) 待核实草稿：先跟主库/待核实区判重，重复的丢掉并记账 */
  const { kept: fresh, dropped: dups } = await dedupeDrafts(baseDir, kept);
  if (dups.length) {
    cell.dropped = Number(cell.dropped ?? 0) + dups.length;
    cell.dupNotes = dups.map((d) => `${d.draft?.name ?? '?'}（${d.why}）`);
    if (!cell.note) cell.note = `去重丢弃 ${dups.length} 条`;
  }
  if (fresh.length) {
    const pendingPath = join(data, 'pending', `ai-${today}.json`);
    const doc = (await readJson(pendingPath, null)) ?? { agent: 'dsflash-ai', domains: [], generatedAt: nowIso(), entries: [] };
    doc.domains = [...new Set([...(doc.domains ?? []), cell.domain])];
    doc.generatedAt = nowIso();
    doc.note = '插件「采风」标签页产出：联网检索 + deepseek-flash 整理，必须人工复核后才能入册。';
    const have = new Set((doc.entries ?? []).map((e) => e.id));
    for (const k of fresh) if (!have.has(k.id)) doc.entries.push(k);
    await writeJson(pendingPath, doc);
  }

  /* 4) 记「这一卷查到第几层」：用过的检索式入池，下一轮换新的 */
  try {
    const st = await readSweepState(baseDir);
    const cursor = { ...(st.cursor ?? {}) };
    const cur = cursor[cell.domain] ?? { used: [], runs: 0 };
    cursor[cell.domain] = {
      used: [...new Set([...(cur.used ?? []), ...(cell.queries ?? [])])].slice(-60),
      runs: (Number(cur.runs) || 0) + 1,
      lastAt: nowIso(),
      lastAngle: cell.angle,
    };
    await patchSweepState(baseDir, { cursor });
  } catch {
    /* 记不到深度也不能影响落盘 */
  }
}

/* ------------------------------------------------------------ 问天书 */

/**
 * 页面「问天书」用的问答：库内检索 +（可选）联网补库外。
 * 返回结构化 JSON 给页面渲染（answer 是纯文本，picks 是库内命中的条目 id）。
 */
export async function ask(baseDir, question, { findNew = false } = {}) {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('问天书：问题不能为空');
  if (q.length > 600) throw new Error('问天书：问题太长了（600 字以内）');

  const t0 = Date.now();
  const payload = (await readJson(join(baseDir, 'data', 'algorithms.json'), null)) ?? { entries: [] };
  const lib = await ai.askLibrary(q, payload, { needQueries: findNew });
  await usage
    .recordUsage(baseDir, {
      kind: 'ask',
      model: ai.MODEL,
      label: `问天书：${q}`,
      usage: lib?.usage,
      elapsedMs: Date.now() - t0,
      ok: true,
    })
    .catch(() => {});
  const out = { question: q, answer: String(lib?.answer ?? ''), picks: Array.isArray(lib?.picks) ? lib.picks : [], queries: [], sources: [], elapsedMs: 0, model: ai.MODEL, from: 'library' };

  if (findNew) {
    out.queries = (lib?.queries ?? []).slice(0, 3);
    if (out.queries.length) {
      const tSearch = Date.now();
      const results = await Promise.all(
        out.queries.map((query) =>
          ai
            .webSearch(query, { maxUses: 2 })
            .then((r) => ({ ...r, ok: true }))
            .catch((err) => ({ sources: [], ok: false, error: err })),
        ),
      );
      await Promise.all(
        results.map((r, i) =>
          usage
            .recordUsage(baseDir, {
              kind: 'sweep-search',
              model: ai.SEARCH_MODEL,
              label: out.queries[i],
              usage: r.usage,
              elapsedMs: Math.round((Date.now() - tSearch) / Math.max(1, results.length)),
              ok: r.ok !== false,
              error: r.error?.message,
            })
            .catch(() => {}),
        ),
      );
      out.sources = mergeSources(results).slice(0, 12);
      out.from = 'library+web';
    }
  }

  /* 命中的条目补上名字/域名，省得页面再查一遍 */
  const byId = new Map((payload.entries ?? []).map((e) => [e.id, e]));
  out.picks = out.picks.map((p) => {
    const e = byId.get(p.id);
    return { ...p, name: p.name ?? e?.name ?? p.id, domain: e?.domain ?? null, year: e?.year ?? null, maturity: e?.maturity ?? null };
  });

  out.elapsedMs = Date.now() - t0;
  return out;
}

/* ------------------------------------------------------------ 复核记账 */

/** 页面上点「已核对 / 已修正 / 还要再查」，等价于 tianji_review_mark。 */
export async function markReview(baseDir, id, status, note) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('复核记账：id 不能为空');
  if (!REVIEW_STATUS.includes(status)) throw new Error(`复核记账：status 只能是 ${REVIEW_STATUS.join(' / ')}`);

  const path = join(baseDir, 'data', 'review.json');
  const ledger = (await readJson(path, null)) ?? {};
  ledger[key] = { status, at: nowIso(), note: String(note ?? '').slice(0, 300) };
  await writeJson(path, ledger);
  return { id: key, ...ledger[key], reviewed: Object.keys(ledger).length };
}

/** 给测试用：把当前任务清掉（不影响磁盘数据）。 */
export function resetJob() {
  job = null;
}
