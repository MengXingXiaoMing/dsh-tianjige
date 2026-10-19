/**
 * 天机阁 · 素材写入（给「用对话框让 AI 改/加素材」这条路兜底）
 *
 * 两条写入路径，故意分开：
 * 1. **新增（stage）**：写成 `data/staging/plugin-<date>.json`，跟采风草稿一样走
 *    「人工复核 → merge → export」，绝不直接动主库。校验复用 ai.sanitizeDrafts，
 *    它已经实现了 id/枚举/URL/来源等硬规则，不满足的直接拒绝并给出原因。
 * 2. **修改（update）**：只改主库里**已存在**条目的文本/链接类字段（名称、摘要、原理、
 *    标签、实现、论文、来源、成熟度、年份、置信度、取舍、注意事项、别名、相关 id）。
 *    写盘前先备份到 `data/backups/algorithms-<时间戳>.json`，改完原子替换。
 *
 * 刻意不允许的两件事：改 id（引用会断）、改 functionKey/domain 这类索引键（会打乱法门统计）——
 * 要改这些请走 staging 新增 + 人工 merge。
 */

import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ai from './ai.mjs';

/** 允许就地修改的字段（id / domain / functionKey 等索引键不在其中）。 */
export const EDITABLE_FIELDS = [
  'name',
  'aliases',
  'summary',
  'howItWorks',
  'whyItMatters',
  'tradeoffs',
  'complexity',
  'inputs',
  'outputs',
  'quality',
  'performance',
  'difficulty',
  'maturity',
  'year',
  'tags',
  'platforms',
  'papers',
  'implementations',
  'variants',
  'bestFor',
  'avoidWhen',
  'relatedIds',
  'confidence',
  'caveats',
  'sources',
];

const pad = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

const algosPath = (baseDir) => join(baseDir, 'data', 'algorithms.json');

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

/**
 * 新增素材的校验：直接借采风草稿那套清洗规则（id/枚举/URL/来源齐全）。
 * @returns {{entry:object|null, problems:string[]}}
 */
export function validateDraft(entry, taxonomy, existingIds = new Set()) {
  const { kept, dropped } = ai.sanitizeDrafts([entry], taxonomy ?? { domains: [] }, existingIds);
  if (kept.length) return { entry: kept[0], problems: [] };
  const first = dropped[0] ?? {};
  const why = Array.isArray(first.why) ? first.why : [first.reason ?? '未通过校验'];
  return { entry: null, problems: why };
}

/**
 * 就地修改的校验：只看 patch 里出现的字段（老条目不必重新满足"新草稿"的全部要求）。
 * @returns {string[]} problems，空数组代表通过
 */
export function validatePatch(before, patch, taxonomy) {
  const problems = [];
  const tax = taxonomy ?? {};
  const maturities = new Set((tax.maturityLevels ?? []).map((m) => m.id));
  const implTypes = new Set((tax.implTypes ?? []).map((m) => m.id));
  const domains = new Set((tax.domains ?? []).map((d) => d.id));
  const subdomains = new Set((tax.domains ?? []).flatMap((d) => (d.subdomains ?? []).map((s) => (typeof s === 'string' ? s : s.id))));

  if ('name' in patch && !String(patch.name ?? '').trim()) problems.push('name 不能为空');
  if ('summary' in patch && String(patch.summary ?? '').trim().length < 8) problems.push('summary 太短（至少 8 个字）');
  if ('maturity' in patch && !maturities.has(patch.maturity)) problems.push(`maturity 只能取 ${[...maturities].join(' / ') || '（分类法里没有枚举）'}`);
  if ('year' in patch && patch.year != null && !Number.isFinite(Number(patch.year))) problems.push('year 必须是数字');
  if ('confidence' in patch && !['high', 'medium', 'low'].includes(patch.confidence)) problems.push('confidence 只能是 high / medium / low');

  for (const key of ['implementations', 'sources', 'papers']) {
    if (!(key in patch)) continue;
    if (!Array.isArray(patch[key])) { problems.push(`${key} 必须是数组`); continue; }
    patch[key].forEach((it, i) => {
      if (!it || typeof it !== 'object') { problems.push(`${key}[${i}] 必须是对象`); return; }
      if (!isHttp(it.url)) problems.push(`${key}[${i}].url 必须是 http(s) 链接`);
      if (!String(it.title ?? it.name ?? '').trim()) problems.push(`${key}[${i}] 缺 title`);
      if (key === 'implementations' && it.type && !implTypes.has(it.type)) problems.push(`implementations[${i}].type 只能取 ${[...implTypes].join(' / ') || '（分类法里没有枚举）'}`);
      if (key === 'sources' && it.kind && !ai.SOURCE_KINDS.includes(it.kind)) problems.push(`sources[${i}].kind 只能取 ${ai.SOURCE_KINDS.join(' / ')}`);
    });
  }

  for (const key of ['tags', 'platforms', 'aliases', 'relatedIds', 'variants', 'bestFor', 'avoidWhen', 'inputs', 'outputs']) {
    if (key in patch && !Array.isArray(patch[key])) problems.push(`${key} 必须是数组`);
  }
  if ('variants' in patch && Array.isArray(patch.variants)) {
    patch.variants.forEach((v, i) => {
      if (!v || typeof v !== 'object') problems.push(`variants[${i}] 必须是对象`);
      else if (v.url && !isHttp(v.url)) problems.push(`variants[${i}].url 必须是 http(s) 链接`);
    });
  }

  /* 只提示不拦截：domain/subdomain 不在分类法里（老数据可能有历史值） */
  if ('domain' in patch && !domains.has(patch.domain)) problems.push('domain 不能在 patch 里改（索引键）');

  return problems;
}

/**
 * 新增素材 → data/staging/plugin-<date>.json（待人工复核后 merge）。
 */
export async function stageEntry(baseDir, raw, taxonomy) {
  const algos = (await readJson(algosPath(baseDir), { entries: [] })) ?? { entries: [] };
  const ids = new Set((algos.entries ?? []).map((e) => e.id));

  const wanted = String(raw?.id ?? '').trim();
  if (wanted && ids.has(wanted)) {
    throw new Error(`id=${wanted} 已经在主库里了；要修改已有条目请用 tianji_update（或走 staging 人工合并）`);
  }

  const { entry, problems } = validateDraft(raw, taxonomy, ids);
  if (!entry) throw new Error(`素材没通过校验：${problems.join('；')}`);

  const dir = join(baseDir, 'data', 'staging');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `plugin-${localDate()}.json`);
  const doc = (await readJson(file, null)) ?? {
    agent: 'dsflash-plugin',
    generatedAt: new Date().toISOString(),
    note: '通过对话框（AI 工具 tianji_stage）写入的候选素材，复核后用 merge 入册。',
    entries: [],
  };
  const have = new Set((doc.entries ?? []).map((e) => e.id));
  if (have.has(entry.id)) {
    doc.entries = doc.entries.map((e) => (e.id === entry.id ? entry : e));
  } else {
    doc.entries.push(entry);
  }
  doc.generatedAt = new Date().toISOString();
  await writeJson(file, doc);
  return { file, id: entry.id, count: doc.entries.length, entry };
}

/**
 * 就地修改已有素材。返回改了哪些字段 + 备份文件路径。
 */
export async function updateEntry(baseDir, id, patch, taxonomy) {
  const key = String(id ?? '').trim();
  if (!key) throw new Error('update：id 不能为空');
  const doc = await readJson(algosPath(baseDir), null);
  if (!doc?.entries) throw new Error(`读不到主库：${algosPath(baseDir)}`);

  const idx = doc.entries.findIndex((e) => e.id === key);
  if (idx < 0) throw new Error(`主库里没有 id=${key}`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('update：patch 必须是一个对象');

  const bad = Object.keys(patch).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (bad.length) {
    throw new Error(`update：这些字段不允许就地改：${bad.join('、')}（可改：${EDITABLE_FIELDS.join('、')}）`);
  }

  const before = doc.entries[idx];
  const problems = validatePatch(before, patch, taxonomy);
  if (problems.length) throw new Error(`update 没通过校验，已放弃写入：${problems.join('；')}`);

  const merged = {
    ...before,
    ...patch,
    id: before.id,
    domain: before.domain,
    functionKey: before.functionKey,
    addedAt: before.addedAt ?? localDate(),
    lastChecked: localDate(),
  };
  const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(before[k]));

  const backupDir = join(baseDir, 'data', 'backups');
  await mkdir(backupDir, { recursive: true });
  const backup = join(backupDir, `algorithms-${stamp()}.json`);
  await copyFile(algosPath(baseDir), backup);

  doc.entries[idx] = merged;
  doc.updatedAt = new Date().toISOString();
  const tmp = `${algosPath(baseDir)}.tmp`;
  await writeJson(tmp, doc);
  await rename(tmp, algosPath(baseDir));

  return { id: key, changed, backup, total: doc.entries.length, entry: merged };
}

/** 读一条（给工具回显用）。 */
export async function getEntry(baseDir, id) {
  const doc = await readJson(algosPath(baseDir), null);
  return (doc?.entries ?? []).find((e) => e.id === String(id ?? '').trim()) ?? null;
}

/** 主库文件在不在（写工具启动时先探一下，给出人话错误）。 */
export async function libraryExists(baseDir) {
  return existsSync(algosPath(baseDir));
}
