// 天书奇谭 · AI 能力后端（dsflash = DeepSeek deepseek-flash）
//
// 三件事：
//   1) 库内问答：把 196 门术法的精简索引丢给模型，让它挑出相关的 + 用人话回答
//   2) 联网检索：走 DeepSeek 原生 web_search（Anthropic 兼容 Messages 端点），拿结构化来源
//   3) 草稿生成：把检索到的来源整理成符合 docs/ENTRY-SCHEMA.md 的候选条目（低置信度、待核实）
//
// 密钥只在本进程内使用，绝不返回给浏览器。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MODEL = "deepseek-flash";           // 对话/整理
export const SEARCH_MODEL = "deepseek-v4-flash"; // 原生联网检索用的 Anthropic 格式模型名
const CHAT_URL = "https://api.deepseek.com/chat/completions";
const SEARCH_URL = "https://api.deepseek.com/anthropic/v1/messages";
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

const SOURCE_KINDS = ["arxiv", "paper", "blog", "repo", "docs", "wiki", "video", "forum", "talk", "survey"];

/* ------------------------------------------------------------------ 密钥 */
const CRED_CANDIDATES = [
  process.env.DSH_CREDENTIALS,
  join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml"),
  join(homedir(), ".dsh", ".credentials.yaml"),
].filter(Boolean);

let keyCache = { at: 0, value: null, from: null };

export async function resolveKey() {
  if (keyCache.value && Date.now() - keyCache.at < 60_000) return keyCache;
  if (process.env.DEEPSEEK_API_KEY) {
    keyCache = { at: Date.now(), value: process.env.DEEPSEEK_API_KEY, from: "env:DEEPSEEK_API_KEY" };
    return keyCache;
  }
  for (const p of CRED_CANDIDATES) {
    try {
      if (!existsSync(p)) continue;
      const text = await readFile(p, "utf8");
      const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text);
      if (m?.[1]) {
        keyCache = { at: Date.now(), value: m[1], from: `credentials:${p}` };
        return keyCache;
      }
    } catch { /* 继续找下一个 */ }
  }
  keyCache = { at: Date.now(), value: null, from: null };
  return keyCache;
}

export async function keyStatus() {
  const k = await resolveKey();
  return { present: Boolean(k.value), from: k.from };
}

/* ------------------------------------------------------------------ 底层调用 */
export class AiError extends Error {
  constructor(message, code = "AI_ERROR", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function post(url, key, body, { accept = "application/json", timeoutMs = 120_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept,
        "x-api-key": key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.message || detail;
      } catch { /* 保留原始片段 */ }
      throw new AiError(`DeepSeek HTTP ${res.status}: ${detail}`, "AI_UPSTREAM", res.status === 401 ? 401 : 502);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err?.name === "AbortError") throw new AiError(`DeepSeek 请求超时（${timeoutMs / 1000}s）`, "AI_TIMEOUT", 504);
    throw new AiError(`DeepSeek 请求失败：${String(err)}`, "AI_TRANSPORT");
  } finally {
    clearTimeout(timer);
  }
}

/** 对话补全，返回纯文本。reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "default"
 *  实测（2026-10-16）：本机这套模型默认走重推理，"none" 可把 reasoning token 从数千降到 0，
 *  端到端从 3.3s → 1.1–1.7s。问天书用它把 70+ 秒压到 20 秒级。 */
export async function chat({ system, user, maxTokens = 1500, temperature = 0.2, reasoningEffort = "minimal" }) {
  const { value: key } = await resolveKey();
  if (!key) throw new AiError("没有找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）", "AI_NO_KEY", 503);
  const data = await post(CHAT_URL, key, {
    model: MODEL,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    ...(reasoningEffort && reasoningEffort !== "default" ? { reasoning_effort: reasoningEffort } : {}),
  });
  const msg = data.choices?.[0]?.message ?? {};
  return { text: msg.content ?? "", reasoning: msg.reasoning_content ?? "", usage: data.usage ?? {}, model: data.model };
}

/** 流式对话补全：逐段回调 onDelta(text)，最终返回全文。用于"答案边生成边显示"。 */
export async function chatStream({ system, user, maxTokens = 2500, temperature = 0.25, reasoningEffort = "minimal", onDelta }) {
  const { value: key } = await resolveKey();
  if (!key) throw new AiError("没有找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）", "AI_NO_KEY", 503);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000);
  let text = "";
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
        max_tokens: maxTokens,
        temperature,
        stream: true,
        ...(reasoningEffort && reasoningEffort !== "default" ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      throw new AiError(`DeepSeek 流式请求失败：${t.slice(0, 300)}`, "AI_STREAM", res.status || 502);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let usage = {};
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta?.content ?? "";
          if (d) {
            text += d;
            onDelta?.(d);
          }
          if (j.usage) usage = j.usage;
        } catch { /* 忽略半行 */ }
      }
    }
    return { text, usage, model: MODEL };
  } catch (err) {
    if (err?.name === "AbortError") throw new AiError("DeepSeek 流式请求超时（180s）", "AI_TIMEOUT", 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON 模式对话补全，返回解析后的对象（失败时抛错，附原始片段）。 */
export async function chatJson({ system, user, maxTokens = 2000, temperature = 0.1, reasoningEffort = "minimal" }) {
  const { value: key } = await resolveKey();
  if (!key) throw new AiError("没有找到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）", "AI_NO_KEY", 503);
  const data = await post(CHAT_URL, key, {
    model: MODEL,
    messages: [
      { role: "system", content: `${system}\n\n只输出一个合法 json 对象，不要包裹代码块，不要额外解释。` },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_object" },
    stream: false,
    ...(reasoningEffort && reasoningEffort !== "default" ? { reasoning_effort: reasoningEffort } : {}),
  });
  const raw = data.choices?.[0]?.message?.content ?? "";
  const usage = data.usage ?? {};
  const truncated = data.choices?.[0]?.finish_reason === "length";
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return { json: JSON.parse(cleaned), raw, usage };
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return { json: JSON.parse(m[0]), raw, usage }; } catch { /* fallthrough */ } }
    // 被 max_tokens 截断的 JSON：尽量把 answer 与已写完的 drafts 救回来
    const answer = salvageAnswer(cleaned);
    const drafts = salvageDrafts(cleaned);
    if (answer || drafts.length) return { json: { answer, drafts }, raw, usage, truncated: true, salvaged: true };
    throw new AiError(`模型没有返回可解析的 JSON${truncated ? "（输出被长度上限截断）" : ""}：${cleaned.slice(0, 200)}`, "AI_BAD_JSON");
  }
}

/** 从截断的 JSON 里抠出已完整的 drafts 数组元素（花括号配平 + 字符串状态机）。 */
function salvageDrafts(text) {
  const m = /"drafts"\s*:\s*\[/.exec(text);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(rest.slice(start, i + 1))); } catch { /* 坏对象跳过 */ }
        start = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) break;
  }
  return out;
}

/** 从可能被截断的 JSON 文本里抠出 answer 字段（转义感知，允许字符串没闭合）。 */
function salvageAnswer(text) {
  const m = /"answer"\s*:\s*"/.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  let out = "", i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "\\") {
      const nx = rest[i + 1] ?? "";
      if (nx === "n") out += "\n";
      else if (nx === "t") out += "\t";
      else if (nx === "r") out += "";
      else if (nx === "u") { const code = parseInt(rest.slice(i + 2, i + 6), 16); out += Number.isFinite(code) ? String.fromCharCode(code) : ""; i += 4; }
      else out += nx;
      i += 2; continue;
    }
    if (ch === '"') break;
    out += ch; i += 1;
  }
  return out.trim();
}

/** DeepSeek 原生联网检索：返回结构化来源（标题/URL/日期/引用片段）。 */
export async function webSearch(query, { maxUses = 3, maxTokens = 2048 } = {}) {
  const { value: key } = await resolveKey();
  if (!key) throw new AiError("没有找到 DEEPSEEK_API_KEY", "AI_NO_KEY", 503);
  const data = await post(SEARCH_URL, key, {
    model: SEARCH_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ ...SEARCH_TOOL, max_uses: maxUses }],
  }, { timeoutMs: 180_000 });

  const snippets = new Map();
  for (const block of data.content ?? []) {
    for (const c of block?.citations ?? []) {
      if (c?.url && c?.cited_text) snippets.set(c.url, String(c.cited_text).slice(0, 400));
    }
  }
  const sources = [];
  const seen = new Set();
  for (const block of data.content ?? []) {
    if (block?.type !== "web_search_tool_result") continue;
    for (const item of Array.isArray(block.content) ? block.content : []) {
      const url = item?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        title: String(item.title ?? url).slice(0, 200),
        url,
        age: item.page_age ?? null,
        snippet: snippets.get(url) ?? null,
      });
    }
  }
  return { sources, usage: data.usage ?? {}, searched: data.usage?.server_tool_use?.web_search_requests ?? 0 };
}

/* ------------------------------------------------------------------ Prompt 素材 */
/** 把导出的库压成紧凑索引（id｜名称｜法门｜卷｜标签｜一句话）。 */
export function buildIndex(payload, { maxChars = 60_000 } = {}) {
  const tax = payload.taxonomy ?? { domains: [] };
  const dom = new Map(tax.domains.map((d) => [d.id, d]));
  const lines = [];
  for (const e of payload.entries ?? []) {
    const d = dom.get(e.domain);
    const aliases = (e.aliases ?? []).slice(0, 2).join("/");
    lines.push([
      e.id,
      e.name,
      aliases,
      d ? `${d.scroll ?? ""}${d.label}` : e.domain,
      e.functionLabel || e.functionKey,
      (e.tags ?? []).slice(0, 4).join(","),
      String(e.summary ?? "").slice(0, 42),
    ].join("｜"));
  }
  const text = lines.join("\n");
  return { text: text.slice(0, maxChars), count: lines.length, truncated: text.length > maxChars };
}

/** 采集端可用的枚举，喂给模型避免它编造分类。 */
export function taxonomyBrief(tax) {
  const domains = (tax.domains ?? []).map((d) =>
    `- ${d.id}（${d.scroll ?? ""} ${d.label}）：${(d.subdomains ?? []).map((s) => s.id).join(", ")}`);
  return [
    "领域与子领域（domain / subdomain 只能取这些值）：",
    ...domains,
    "",
    `成熟度 maturity 只能取：${(tax.maturityLevels ?? []).map((m) => m.id).join(" / ")}`,
    `现成实现类型 implementations[].type 只能取：${(tax.implTypes ?? []).map((m) => m.id).join(" / ")}`,
    `来源类型 sources[].kind 只能取：${SOURCE_KINDS.join(" / ")}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ 三个动作 */
const PICK_SYSTEM = `你是《天书奇谭》算法辑录的检索助手。用户用自然语言描述他想做的事，你要从给定的术法索引里挑出真正相关的条目，并用中文给出选型建议。
要求：
- picks 里的 id 必须原样来自索引，不能编造；最多 8 个，按相关度从高到低。
- 如果索引里确实没有相关的，picks 返回空数组，并在 answer 里说明库里没有、建议联网检索。
- answer 用中文，先一句话给结论，再分点说清"选哪个、为什么、代价是什么"，不要复述全部条目。
返回 json：{"answer": "…", "picks": [{"id": "…", "why": "一句话理由"}]}`;

export async function askLibrary(question, payload) {
  const index = buildIndex(payload);
  const { json, usage } = await chatJson({
    system: PICK_SYSTEM,
    user: `术法索引（每行：id｜名称｜别名｜卷｜法门｜标签｜摘要）：\n${index.text}\n\n用户的问题是：\n${question}`,
    maxTokens: 2800,
  });
  const ids = new Set((payload.entries ?? []).map((e) => e.id));
  let picks = (Array.isArray(json.picks) ? json.picks : [])
    .map((p) => (typeof p === "string" ? { id: p, why: "" } : p))
    .filter((p) => p?.id && ids.has(p.id))
    .slice(0, 8);
  let fallback = false;
  if (!picks.length) {
    picks = localPick(question, payload, 5);
    fallback = picks.length > 0;
  }
  return { answer: String(json.answer ?? "").trim(), picks, usage, indexCount: index.count };
}

const QUERY_SYSTEM = `你负责把用户的一句话需求，变成最有效的英文/中文学术或工程检索式，用于搜索"算法/技术方案"。
- 输出 1–3 条 query，尽量包含领域术语（如 hair simulation、position based dynamics、Gaussian Splatting）。
- 不要输出解释。
返回 json：{"queries": ["…", "…"]}`;

export async function planQueries(question) {
  const { json } = await chatJson({ system: QUERY_SYSTEM, user: question, maxTokens: 400 });
  const qs = (Array.isArray(json.queries) ? json.queries : []).map((q) => String(q).trim()).filter(Boolean);
  return qs.slice(0, 3);
}

const DRAFT_SYSTEM = `你是《天书奇谭》算法辑录的录入助手。根据用户需求、已有索引命中和联网检索到的来源，整理出"值得收录但库里还没有"的候选术法。
硬性规则（违反即作废）：
- 不许编造 URL：implementations[].url 和 sources[].url 只能来自我给你的检索结果里的 URL，原样复制。
- 只能从给定的枚举值里选 domain / subdomain / maturity / implementations[].type / sources[].kind。
- id 用小写 kebab-case 英文（如 hair-strand-solver），name 保留通用英文名或中文译名（可两者都给，用中文为主）。
- summary 一句话说清"它做什么"；howItWorks 3–6 句说清原理；都要中文、说人话。
- 不确定的地方写进 caveats，不要猜。
返回 json：{"drafts": [{"id","name","aliases","domain","subdomain","functionKey","functionLabel","summary","howItWorks","maturity","year","tags","platforms","papers":[{"title","url"}],"implementations":[{"name","url","type","note"}],"sources":[{"title","url","kind"}],"whyItMatters","tradeoffs","caveats","confidence"}]}`;

export async function proposeDrafts({ question, sources, knownIndex, tax, maxDrafts = 3 }) {
  const src = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}${s.age ? ` (${s.age})` : ""}${s.snippet ? `\n    引用片段：${s.snippet}` : ""}`).join("\n");
  const { json, usage } = await chatJson({
    system: DRAFT_SYSTEM,
    user: `${taxonomyBrief(tax)}\n\n用户需求：${question}\n\n库里已有的相关条目（不要重复产出这些 id）：${knownIndex || "（无）"}\n\n联网检索到的来源（只能用这些 URL）：\n${src || "（这次没有检索到来源）"}\n\n请最多给出 ${maxDrafts} 个候选。`,
    maxTokens: 3200,
  });
  return { drafts: Array.isArray(json.drafts) ? json.drafts : [], usage };
}

/* ------------------------------------------------------------------ 清洗与校验 */
const kebab = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const httpUrl = (s) => (typeof s === "string" && /^https?:\/\//i.test(s) ? s : null);
const strArr = (a, max = 12) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);

/** 把模型给的草稿清洗成能通过 CLI 校验的形状；不合格的直接丢弃并记账。 */
export function sanitizeDrafts(drafts, tax, existingIds) {
  const doms = new Map((tax.domains ?? []).map((d) => [d.id, d]));
  const maturities = new Set((tax.maturityLevels ?? []).map((m) => m.id));
  const implTypes = new Set((tax.implTypes ?? []).map((m) => m.id));
  const kept = [], dropped = [], today = new Date().toISOString().slice(0, 10);

  for (const d of drafts) {
    const why = [];
    const id = kebab(d?.id || d?.name);
    if (!id) why.push("缺少 id");
    else if (existingIds.has(id)) why.push(`id 已存在（${id}）`);
    const dom = doms.get(d?.domain);
    if (!dom) why.push(`domain 非法（${d?.domain}）`);
    if (why.length) { dropped.push({ id: id || "(无)", name: d?.name, why }); continue; }

    const sub = (dom.subdomains ?? []).some((s) => s.id === d.subdomain)
      ? d.subdomain
      : (dom.subdomains ?? [])[0]?.id ?? d.subdomain;

    const implementations = (Array.isArray(d.implementations) ? d.implementations : [])
      .map((i) => ({
        name: String(i?.name ?? "").trim(),
        url: httpUrl(i?.url),
        type: implTypes.has(i?.type) ? i.type : "github",
        note: i?.note ? String(i.note).slice(0, 200) : undefined,
      }))
      .filter((i) => i.name && i.url)
      .slice(0, 6);

    const sources = (Array.isArray(d.sources) ? d.sources : [])
      .map((s) => ({
        title: String(s?.title ?? "").trim() || "来源",
        url: httpUrl(s?.url),
        kind: SOURCE_KINDS.includes(s?.kind) ? s.kind : "blog",
      }))
      .filter((s) => s.url)
      .slice(0, 8);

    if (!sources.length) { dropped.push({ id, name: d.name, why: ["没有任何可用 URL 来源（不许编造 URL）"] }); continue; }

    const papers = (Array.isArray(d.papers) ? d.papers : [])
      .map((p) => ({ title: String(p?.title ?? "").trim() || "论文", url: httpUrl(p?.url) }))
      .filter((p) => p.url).slice(0, 6);
    // 库规要求 papers 至少 1 条：从来源里挑一条论文类（arxiv/paper/talk/survey），不编造
    if (!papers.length) {
      const paperish = sources.find((s) => ["arxiv", "paper", "talk", "survey"].includes(s.kind)) || sources[0];
      if (paperish) papers.push({ title: paperish.title, url: paperish.url });
    }

    const year = Number.isFinite(+d.year) && +d.year >= 1950 && +d.year <= 2100 ? Math.trunc(+d.year) : new Date().getFullYear();

    kept.push({
      id,
      name: String(d.name ?? id).trim().slice(0, 120),
      aliases: strArr(d.aliases, 4),
      domain: dom.id,
      subdomain: sub,
      functionKey: kebab(d.functionKey || d.functionLabel || d.name) || id,
      functionLabel: String(d.functionLabel ?? d.name ?? id).trim().slice(0, 60),
      summary: String(d.summary ?? "").trim().slice(0, 300),
      howItWorks: String(d.howItWorks ?? "").trim().slice(0, 1200),
      maturity: maturities.has(d.maturity) ? d.maturity : "experimental",
      year,
      tags: strArr(d.tags, 8),
      platforms: strArr(d.platforms, 6),
      papers,
      implementations,
      sources,
      whyItMatters: d.whyItMatters ? String(d.whyItMatters).slice(0, 400) : undefined,
      tradeoffs: d.tradeoffs ? String(d.tradeoffs).slice(0, 400) : undefined,
      caveats: [d.caveats ? String(d.caveats).slice(0, 400) : "", "本条由 dsflash 联网检索自动生成，尚未人工核实（URL 来自检索结果，未逐条打开确认）。"]
        .filter(Boolean).join(" "),
      confidence: "low",
      addedAt: today,
      lastChecked: today,
      origin: "ai-draft",
    });
  }
  return { kept, dropped };
}

export { SOURCE_KINDS };
