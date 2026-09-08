import { config } from "../config.mjs";
import { getDb } from "../db.mjs";

const ORIGIN = config.aiHot.origin || "https://aihot.virxact.com";
const TTL = 15 * 60 * 1000;

const ATTENTION_DOMAINS = [
  { id: "agent-work", label: "Agent 与工具工作流", patterns: [/agents?/i, /智能体|工具调用|工作流|自动化|MCP|Codex/i] },
  { id: "guardrails", label: "安全与政策边界", patterns: [/安全|越权|泄露|隐私|版权|监管|政策|法院/i] },
  { id: "capability", label: "AI 能力边界", patterns: [/模型发布|新模型|推理|基准|开源模型/i] },
  { id: "knowledge", label: "知识工作", patterns: [/知识|文档|办公|研究|搜索|写作|记忆/i] },
];

function asArray(v) { return Array.isArray(v) ? v : []; }
function compact(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }

function domainsFor(item) {
  const hay = [item.title, item.summary, item.source?.name, ...asArray(item.sourceNames)].filter(Boolean).join(" ");
  return ATTENTION_DOMAINS.filter((d) => d.patterns.some((p) => p.test(hay))).map(({ id, label }) => ({ id, label }));
}
function evidence(item) {
  if (item.sourceCount >= 2) return { level: "multi-source", label: `${item.sourceCount} 个独立信源` };
  if (item.links?.original) return { level: "original-linked", label: "可回查原文" };
  return { level: "summary-only", label: "仅聚合摘要" };
}
function decorate(item) {
  const domains = domainsFor(item);
  const story = item.links?.aihot || item.links?.original || null;
  return {
    ...item,
    categoryLabel: item.source?.name || "AI HOT",
    links: { ...item.links, story },
    discoveredAt: new Date().toISOString(),
    attention: { domains, reason: domains[0] ? `与${domains[0].label}相关` : "AI HOT 精选，可按兴趣浏览" },
    evidence: evidence(item),
  };
}

async function fetchJson(path) {
  const res = await fetch(`${ORIGIN}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`AI HOT ${path} HTTP ${res.status}`);
  return res.json();
}

export const aihot = {
  async load({ force = false } = {}) {
    const db = getDb();
    const cached = db.prepare("SELECT payload_json, fetched_at FROM ai_hot_cache ORDER BY id DESC LIMIT 1").get();
    const now = Date.now();
    if (!force && cached && now - new Date(cached.fetched_at).getTime() < TTL) {
      return JSON.parse(cached.payload_json);
    }
    const [hot, selected, daily] = await Promise.all([
      fetchJson("/api/v1/hot-topics"),
      fetchJson("/api/v1/items?mode=selected&window=24h&limit=20"),
      fetchJson("/api/v1/dailies/latest"),
    ]);
    const hotItems = asArray(hot?.items).map((it) => decorate({
      id: String(it.id || Math.random()), kind: "hot-topic", title: compact(it.title), summary: null,
      source: { name: it.source?.name || "AI HOT" }, sourceCount: Number(it.sourceCount || 1),
      links: { aihot: it.links?.aihot || null, original: it.links?.original || null },
    }));
    const selectedItems = asArray(selected?.items).map((it) => decorate({
      id: String(it.id || Math.random()), kind: "selected", title: compact(it.title), summary: compact(it.summary),
      source: { name: it.source?.name || "未知" }, sourceCount: 1,
      links: { aihot: it.links?.aihot || null, original: it.links?.original || null },
    }));

    const multiSource = hotItems.filter((i) => i.sourceCount >= 2);
    const mustRead = multiSource.filter((i) => i.attention.domains.length).slice(0, 3);
    const mustReadIds = new Set(mustRead.map((i) => i.id));

    const rest = [...hotItems, ...selectedItems].filter((i) => !mustReadIds.has(i.id));
    const browse = rest.slice(0, 8);
    const browseIds = new Set(browse.map((i) => i.id));
    const other = rest.filter((i) => !browseIds.has(i.id)).slice(0, 12);

    const report = daily?.report || daily || {};
    const payload = {
      status: "live",
      fetchedAt: new Date(now).toISOString(),
      source: { name: "AI HOT", url: `${ORIGIN}/agent` },
      counts: {
        upstreamHot: multiSource.length,
        upstreamSelected24h: selectedItems.length,
        mustRead: mustRead.length,
        browse: browse.length,
      },
      tiers: { mustRead, browse, other },
      daily: {
        date: report.date || null,
        itemCount: report.itemCount ?? null,
        links: { aihot: report.links?.aihot || `${ORIGIN}/daily` },
      },
    };
    db.prepare("INSERT INTO ai_hot_cache(payload_json, fetched_at) VALUES(?, ?)").run(JSON.stringify(payload), new Date(now).toISOString());
    return payload;
  },
};
