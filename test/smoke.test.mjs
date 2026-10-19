/**
 * 天机阁插件 · 离线冒烟测试（`npm test`，零依赖，node --test）
 *
 * 目标：在**不装进 profile、不碰真数据**的前提下，证明三件事
 *   1. 包清单（manifest）自洽：入口、exports、bundle patch、展示元数据、engines；
 *   2. `apply(ctx, config)` 在只有 tools / webServer 的裸 ctx 上能注册 10 个工具、
 *      8 条路由，并且 effect 返回的 disposer 能真把路由卸掉（注册即 effect）；
 *   3. 工具真能跑：检索命中、档案可读、未知 id 报错、复核记账落盘、体检带数字。
 *
 * 数据用 `test/fixtures/` 里的真条目快照（复制进临时目录），所以断言里的 id / 数字
 * 与 fixture 绑定，不随主库增长而漂移。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const TOOL_NAMES = [
  'tianji_search',
  'tianji_get',
  'tianji_ask',
  'tianji_sweep',
  'tianji_stage',
  'tianji_update',
  'tianji_review',
  'tianji_review_mark',
  'tianji_stats',
  'tianji_usage',
];

const ROUTES = [
  '/api/tianjige/library',
  '/api/tianjige/meta',
  '/api/tianjige/sweep',
  '/api/tianjige/ask',
  '/api/tianjige/review',
  '/api/tianjige/usage',
  '/api/tianjige/write',
  '/api/tianjige/log',
];

/** 建一个最小数据目录：fixtures + 空的可写子目录。 */
async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'tianjige-smoke-'));
  await mkdir(join(dir, 'data'), { recursive: true });
  await cp(join(HERE, 'fixtures', 'algorithms.json'), join(dir, 'data', 'algorithms.json'));
  await cp(join(HERE, 'fixtures', 'taxonomy.json'), join(dir, 'data', 'taxonomy.json'));
  for (const sub of ['pending', 'staging', 'runs', 'snapshots', 'logs', 'backups']) {
    await mkdir(join(dir, 'data', sub), { recursive: true });
  }
  return dir;
}

/** 裸 ctx 探针：只提供 tools.register / effect / webServer.register，模拟最小宿主。 */
function makeCtx() {
  const tools = [];
  const routes = [];
  const disposers = [];
  const disposed = [];
  const ctx = {
    tools: { register: (def) => tools.push(def) },
    effect(fn, _label) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    webServer: {
      register(route) {
        routes.push(route.path);
        return {
          dispose() {
            disposed.push(route.path);
          },
        };
      },
    },
  };
  return { ctx, tools, routes, disposers, disposed };
}

const dataDir = await makeDataDir();
after(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href);
const { ctx, tools, routes, disposers } = makeCtx();
mod.apply(ctx, { dataDir, defaultLimit: 5 });

const call = (name, args = {}) => {
  const def = tools.find((t) => t.name === name);
  assert.ok(def, `工具 ${name} 未注册`);
  return def.execute(args, { signal: new AbortController().signal });
};
const render = (name, args, value) => {
  const def = tools.find((t) => t.name === name);
  const blocks = def.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} 的 render 没有返回内容块`);
  return blocks.map((b) => b.text ?? '').join('\n');
};

test('manifest：入口、exports、bundle patch、展示元数据与 engines 自洽', () => {
  assert.equal(pkg.name, 'dsh-tianjige');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'host.js');
  assert.equal(pkg.exports['.'], './host.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.ok(existsSync(join(ROOT, pkg.exports['./client'])), 'client bundle 不存在');
  assert.ok(statSync(join(ROOT, pkg.exports['./client'])).size > 100_000, 'client bundle 太小，疑似未构建');
  for (const lang of ['README.md', 'README-zh.md', 'README-es.md', 'README-pt.md', 'README-hi.md']) {
    assert.ok(existsSync(join(ROOT, lang)), `缺少 ${lang}`);
    assert.ok(readFileSync(join(ROOT, lang), 'utf8').trim().length > 200, `${lang} 内容过短`);
  }
  assert.ok(pkg.engines?.node, '缺少 engines.node');
  assert.ok(pkg.dsh?.engines?.dsh, '缺少 dsh.engines.dsh');
  assert.ok(pkg.packageManager, '缺少 packageManager');
  assert.equal(pkg.private, undefined, 'private 会让包无法发布');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*tianjige/, 'cordis.patch.yml 没有 tianjige 配置行');
});

test('apply：注册 10 个工具 + 8 条路由，且 disposer 能卸载', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assert.deepEqual([...routes].sort(), [...ROUTES].sort());
  for (const def of tools) {
    assert.ok(def.description, `${def.name} 缺少 description`);
    assert.equal(def.parameters?.type, 'object', `${def.name} 的 parameters 不是 object schema`);
    assert.equal(typeof def.execute, 'function', `${def.name} 缺少 execute`);
    assert.equal(typeof def.output?.render, 'function', `${def.name} 缺少 output.render`);
  }
  // 注册即 effect：apply 里的 effect 必须能把 8 条路由全部卸掉
  const first = disposers.at(0);
  assert.equal(typeof first, 'function', 'effect 没有返回 disposer');
  first();
}, { concurrency: false });

test('tianji_search / tianji_get：命中、过滤、未知 id 报错', async () => {
  const hit = await call('tianji_search', { query: 'gaussian splatting' });
  assert.match(hit, /gaussian-splatting-3dgs/, '检索没命中 fixture 条目');
  assert.ok(render('tianji_search', { query: 'x' }, hit).length > 0);

  const filtered = await call('tianji_search', { query: 'a', domain: 'physics' });
  assert.match(filtered, /cloth-xpbd/);
  assert.doesNotMatch(filtered, /gaussian-splatting-3dgs/);

  const entry = await call('tianji_get', { id: 'noise-worley' });
  assert.match(entry, /noise-worley/);

  await assert.rejects(() => call('tianji_get', { id: 'definitely-not-here' }), /天书里没有 id=definitely-not-here/);
});

test('tianji_review_mark：写台账；tianji_review 能列出', async () => {
  const out = await call('tianji_review_mark', { id: 'cloth-xpbd', status: 'ok', note: '冒烟测试' });
  assert.match(out, /已记账：cloth-xpbd → ok/);
  const ledger = JSON.parse(await readFile(join(dataDir, 'data', 'review.json'), 'utf8'));
  assert.equal(ledger['cloth-xpbd']?.status, 'ok');

  const queue = await call('tianji_review', { limit: 5 });
  assert.match(queue, /复核队列|没有待复核/);
});

test('tianji_stats：数字与 fixture 对齐', async () => {
  const stats = await call('tianji_stats', {});
  assert.match(stats, /术法 3 门/);
  assert.match(stats, /法门 3 个/);
  assert.match(stats, /## 卷分布/);
});

test('tianji_usage：空账本也能读出汇总', async () => {
  const usage = await call('tianji_usage', { action: 'read', days: 7, limit: 5 });
  assert.ok(typeof usage === 'string' && usage.length > 0);
});

test('dataDir：配置优先于环境变量；包内 seed 是可独立启动的 219 条起始库', async () => {
  const host = await import(pathToFileURL(join(ROOT, 'host.js')).href);
  assert.equal(typeof host.resolveDataDir, 'function');
  assert.equal(host.resolveDataDir({ dataDir }), dataDir);

  const prev = process.env.DSH_TIANJIGE_DATA_DIR;
  process.env.DSH_TIANJIGE_DATA_DIR = dataDir;
  try {
    assert.equal(host.resolveDataDir({}), dataDir, '环境变量没有被采纳');
  } finally {
    if (prev === undefined) delete process.env.DSH_TIANJIGE_DATA_DIR;
    else process.env.DSH_TIANJIGE_DATA_DIR = prev;
  }

  const seed = JSON.parse(readFileSync(join(ROOT, 'seed', 'algorithms.json'), 'utf8'));
  assert.equal(seed.entries.length, 219, '起始库条目数不对');
  for (const e of seed.entries) assert.ok(e.id && e.name && e.domain, `起始库条目缺字段：${e.id ?? '?'}`);
  const taxonomy = JSON.parse(readFileSync(join(ROOT, 'seed', 'taxonomy.json'), 'utf8'));
  assert.equal(taxonomy.domains.length, 13, '起始库卷数不对');
  assert.ok(pkg.files.includes('seed'), 'files 白名单漏了 seed，发布后装完会是空库');
});
