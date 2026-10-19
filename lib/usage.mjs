/**
 * 天机阁 · 模型用量账本（token 记账）
 *
 * 页面每一次调 AI（问天书 / 采风检索 / 采风整理）都记一笔：什么时候、哪一类、
 * 哪个模型、prompt / completion / total tokens、联网检索次数、耗时、以及一句话说明。
 *
 * 磁盘格式 `data/usage.json`：
 * {
 *   version: 1,
 *   updatedAt: '2026-10-17T12:40:00.000Z',
 *   retentionDays: 30,                       // 超过这么多天的明细自动删
 *   lifetime: { calls, promptTokens, completionTokens, totalTokens, searches },  // 累计（删掉的也算）
 *   calls: [{ id, at, kind, model, label, domain, promptTokens, completionTokens,
 *             totalTokens, searches, elapsedMs, ok, error }]
 * }
 *
 * 两个设计取舍：
 * 1. **累计与窗口分开**：明细会按保留天数/条数裁剪，`lifetime` 是不回退的累计计数器，
 *    所以"这个月花了多少"和"从装机到现在花了多少"都能看到。
 * 2. **单写者串行**：同一进程里的写操作排成一条链（`locked`），避免采风并发格子把
 *    usage.json 写坏；磁盘写入走 tmp + rename（原子替换）。
 *
 * 历史不回填：功能上线前发生的调用没有记录，`firstAt` 就是账单的起点。
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const USAGE_FILE = 'usage.json';
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_CALLS = 2000;

/** 记录类别：页面上分组用，新增类别记得同步 client.js 的 KIND_LABEL。 */
export const KINDS = ['ask', 'sweep-search', 'sweep-draft', 'plan', 'other'];

const usagePath = (baseDir) => join(baseDir, 'data', USAGE_FILE);
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyLedger() {
  return {
    version: 1,
    updatedAt: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
    lifetime: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, searches: 0 },
    calls: [],
  };
}

/**
 * 把两种 API 的 usage 形状归一成同一组数字：
 * - OpenAI/DeepSeek chat：{prompt_tokens, completion_tokens, total_tokens}
 * - Anthropic messages（联网检索）：{input_tokens, output_tokens, server_tool_use:{web_search_requests}}
 */
export function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens) || 0;
  const searches = Number(u.server_tool_use?.web_search_requests ?? 0) || 0;
  return { promptTokens, completionTokens, totalTokens, searches };
}

const newId = () => `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clampDays = (n) => Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(Number(n) || DEFAULT_RETENTION_DAYS)));

/** 未过期的明细（保留期按 `at` 判）。 */
function keepRecent(ledger) {
  const days = clampDays(ledger.retentionDays);
  const cutoff = Date.now() - days * DAY_MS;
  return (ledger.calls ?? []).filter((c) => {
    const t = Date.parse(c?.at ?? '');
    return Number.isFinite(t) ? t >= cutoff : false;
  });
}

async function readRaw(baseDir) {
  const path = usagePath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(await readFile(path, 'utf8'));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null; // 坏文件当没有，下一次写盘会重建
  }
}

/** 读账本（并顺手做一次裁剪，不写盘）。 */
export async function readUsage(baseDir) {
  const raw = await readRaw(baseDir);
  if (!raw) return { ...emptyLedger(), firstAt: null };
  const ledger = {
    ...emptyLedger(),
    ...raw,
    retentionDays: clampDays(raw.retentionDays),
    lifetime: { ...emptyLedger().lifetime, ...(raw.lifetime ?? {}) },
    calls: keepRecent(raw),
  };
  ledger.firstAt = ledger.calls.length ? ledger.calls[0].at : null;
  return ledger;
}

/* 同一进程内的写操作串行化（采风是并发的，必须排队）。 */
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 原子写盘：先写 .tmp 再 rename。 */
async function writeLedger(baseDir, ledger) {
  const path = usagePath(baseDir);
  await mkdir(join(baseDir, 'data'), { recursive: true });
  ledger.updatedAt = new Date().toISOString();
  ledger.retentionDays = clampDays(ledger.retentionDays);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  await rename(tmp, path);
  return ledger;
}

/**
 * 记一笔用量。
 * @param {string} baseDir 项目根
 * @param {{kind?:string, model?:string, label?:string, domain?:string|null, usage?:object,
 *          elapsedMs?:number, ok?:boolean, error?:string|null, at?:string}} entry
 */
export function recordUsage(baseDir, entry = {}) {
  return locked(async () => {
    const ledger = await readUsage(baseDir);
    const u = normalizeUsage(entry.usage);
    const call = {
      id: newId(),
      at: entry.at ?? new Date().toISOString(),
      kind: KINDS.includes(entry.kind) ? entry.kind : 'other',
      model: String(entry.model ?? '').slice(0, 60) || null,
      label: String(entry.label ?? '').replace(/\s+/g, ' ').slice(0, 180) || null,
      domain: entry.domain ? String(entry.domain) : null,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.totalTokens,
      searches: u.searches,
      elapsedMs: Number.isFinite(entry.elapsedMs) ? Math.max(0, Math.round(entry.elapsedMs)) : null,
      ok: entry.ok !== false,
      error: entry.error ? String(entry.error).slice(0, 300) : null,
    };
    ledger.calls.push(call);
    if (ledger.calls.length > MAX_CALLS) ledger.calls.splice(0, ledger.calls.length - MAX_CALLS);
    ledger.calls = keepRecent(ledger);
    const lifetime = ledger.lifetime;
    lifetime.calls += 1;
    lifetime.promptTokens += u.promptTokens;
    lifetime.completionTokens += u.completionTokens;
    lifetime.totalTokens += u.totalTokens;
    lifetime.searches += u.searches;
    await writeLedger(baseDir, ledger);
    return call;
  });
}

/** 删明细：按 id 列表 / 按"早于 N 天" / 全部。返回删了多少条。 */
export function clearUsage(baseDir, { ids, olderThanDays, all } = {}) {
  return locked(async () => {
    const ledger = await readUsage(baseDir);
    const before = ledger.calls.length;
    if (all === true) {
      ledger.calls = [];
    } else if (Array.isArray(ids) && ids.length) {
      const drop = new Set(ids.map(String));
      ledger.calls = ledger.calls.filter((c) => !drop.has(c.id));
    } else if (Number(olderThanDays) > 0) {
      const cutoff = Date.now() - Number(olderThanDays) * DAY_MS;
      ledger.calls = ledger.calls.filter((c) => {
        const t = Date.parse(c?.at ?? '');
        return Number.isFinite(t) ? t >= cutoff : false;
      });
    } else {
      throw new Error('清账：要么给 ids，要么给 olderThanDays，要么 all=true');
    }
    const removed = before - ledger.calls.length;
    await writeLedger(baseDir, ledger);
    return { removed, left: ledger.calls.length };
  });
}

/** 设保留天数（超过的明细下次读取/写盘时被裁掉）。返回实际裁剪条数。 */
export function setRetention(baseDir, days) {
  return locked(async () => {
    const ledger = await readUsage(baseDir);
    const want = clampDays(days);
    const before = ledger.calls.length;
    ledger.retentionDays = want;
    ledger.calls = keepRecent(ledger);
    await writeLedger(baseDir, ledger);
    return { retentionDays: want, removed: before - ledger.calls.length, left: ledger.calls.length };
  });
}

/** 7 天 × 24 小时的桶，给页画画小柱子（没有记录的天记 0）。 */
function dailyBuckets(calls, days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: key, calls: 0, totalTokens: 0 });
  }
  const byDate = new Map(out.map((b) => [b.date, b]));
  for (const c of calls) {
    const t = Date.parse(c?.at ?? '');
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const b = byDate.get(key);
    if (!b) continue;
    b.calls += 1;
    b.totalTokens += Number(c.totalTokens) || 0;
  }
  return out;
}

/**
 * 汇总：窗口期（默认 7 天）内 + 累计 + 最近若干条明细 + 每天的小柱状图。
 * @param {string} baseDir
 * @param {{days?:number, limit?:number}} opts
 */
export async function summarizeUsage(baseDir, { days = 7, limit = 50 } = {}) {
  const ledger = await readUsage(baseDir);
  const win = Math.min(365, Math.max(1, Math.round(Number(days) || 7)));
  const cutoff = Date.now() - win * DAY_MS;
  const inWindow = ledger.calls.filter((c) => {
    const t = Date.parse(c?.at ?? '');
    return Number.isFinite(t) && t >= cutoff;
  });

  const byKind = {};
  const add = (bucket, c) => {
    bucket.calls += 1;
    bucket.totalTokens += Number(c.totalTokens) || 0;
    bucket.promptTokens += Number(c.promptTokens) || 0;
    bucket.completionTokens += Number(c.completionTokens) || 0;
    bucket.searches += Number(c.searches) || 0;
  };
  for (const c of inWindow) {
    const k = c.kind ?? 'other';
    byKind[k] = byKind[k] ?? { calls: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, searches: 0 };
    add(byKind[k], c);
  }

  const todayKey = dailyBuckets(ledger.calls, 1)[0]?.date;
  const today = inWindow.filter((c) => {
    const t = Date.parse(c?.at ?? '');
    if (!Number.isFinite(t)) return false;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return key === todayKey;
  });

  return {
    at: new Date().toISOString(),
    retentionDays: ledger.retentionDays,
    firstAt: ledger.firstAt,
    lifetime: ledger.lifetime,
    window: {
      days: win,
      calls: inWindow.length,
      totalTokens: inWindow.reduce((s, c) => s + (Number(c.totalTokens) || 0), 0),
      promptTokens: inWindow.reduce((s, c) => s + (Number(c.promptTokens) || 0), 0),
      completionTokens: inWindow.reduce((s, c) => s + (Number(c.completionTokens) || 0), 0),
      searches: inWindow.reduce((s, c) => s + (Number(c.searches) || 0), 0),
      byKind,
    },
    today: {
      date: todayKey,
      calls: today.length,
      totalTokens: today.reduce((s, c) => s + (Number(c.totalTokens) || 0), 0),
    },
    daily: dailyBuckets(ledger.calls, Math.min(14, Math.max(win, 7))),
    // 最近若干条（新的在前），页面列表直接渲染
    calls: ledger.calls
      .slice(-Math.min(MAX_CALLS, Math.max(1, Number(limit) || 50)))
      .reverse(),
  };
}

/** 给测试用：删掉账本文件。 */
export async function resetUsageFile(baseDir) {
  const path = usagePath(baseDir);
  if (existsSync(path)) await unlink(path);
}
