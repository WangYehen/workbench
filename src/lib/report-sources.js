// 日报「来源明细」（sourceRefs）的归一化与分组工具。
// 纯函数、零框架依赖：前端渲染与后端测试共用，避免两处实现口径漂移。
//
// 数据契约：新日报的 sourceRefs 为对象数组
//   [{ ref, kind, title, detail, priority, recommendedAction }]
// 历史日报的 sourceRefs 为字符串数组（如 "outlook:123"），此处统一降级处理。

// 字符串来源引用前缀 → 明细类别
const REF_PREFIX_KIND = {
  outlook: "email",
  email: "email",
  todo: "todo",
  dingtalk: "blocker",
  project: "project",
};

// 明细类别 → 分组（团队日志把 blocker / review 合并展示）
const GROUP_ORDER = ["email", "todo", "team", "project", "other"];

const GROUP_META = {
  email: { label: "邮件", route: "/mail" },
  todo: { label: "待办", route: "/todo" },
  team: { label: "团队日志", route: "/team" },
  project: { label: "项目", route: "/projects" },
  other: { label: "其他", route: null },
};

/**
 * 从历史字符串引用推断明细类别，未知前缀归入 other。
 * @param {string} ref
 * @returns {string}
 */
export function kindFromRef(ref) {
  const prefix = String(ref || "").split(":")[0];
  return REF_PREFIX_KIND[prefix] || "other";
}

/**
 * 明细类别 → 展示分组键。
 * @param {string} kind
 * @returns {string}
 */
export function groupKeyFromKind(kind) {
  if (kind === "blocker" || kind === "review") return "team";
  if (kind === "email" || kind === "todo" || kind === "project") return kind;
  return "other";
}

/**
 * 优先级排序权重，P0 最靠前。
 * @param {string} priority
 * @returns {number}
 */
export function priorityRank(priority) {
  return { P0: 0, high: 0, P1: 1, medium: 1, P2: 2, low: 2 }[priority] ?? 3;
}

/**
 * 归一化单条来源明细，兼容对象（新）与字符串（历史）两种格式。
 * 历史字符串只保留 ID 作为标题，绝不抛错。
 * @param {object|string} entry
 * @returns {{ref:string,kind:string,title:string,detail:string,priority:string,recommendedAction:string,legacy:boolean}}
 */
export function normalizeSourceRef(entry) {
  if (entry && typeof entry === "object") {
    const ref = String(entry.ref || entry.sourceRef || "").trim();
    const kind = entry.kind || kindFromRef(ref);
    return {
      ref,
      kind,
      title: String(entry.title || ref || "").trim(),
      detail: String(entry.detail || "").trim(),
      priority: entry.priority || "P2",
      recommendedAction: String(entry.recommendedAction || "").trim(),
      legacy: false,
    };
  }
  // 历史格式："outlook:123" / "todo:t9" / "dingtalk:u1:2026-09-01"
  const ref = String(entry == null ? "" : entry).trim();
  const kind = kindFromRef(ref);
  const segments = ref.split(":");
  const id = segments.slice(1).join(":") || ref;
  return {
    ref,
    kind,
    title: id,
    detail: "",
    priority: "P2",
    recommendedAction: "",
    legacy: true,
  };
}

/**
 * 归一化来源明细列表，过滤空项。
 * @param {Array<object|string>} list
 * @returns {Array<object>}
 */
export function normalizeSourceRefs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeSourceRef)
    .filter((item) => item.ref || item.title);
}

/**
 * 计算跳转目标路由；无法定位时返回 null（前端据此隐藏按钮）。
 * 团队日志带上日报日期，落到对应成员的当日日志。
 * @param {{kind:string,ref:string}} item
 * @returns {string|null}
 */
export function sourceRefTarget(item) {
  const group = groupKeyFromKind(item && item.kind);
  const meta = GROUP_META[group];
  if (!meta || !meta.route) return null;
  if (group === "team") {
    const date = String((item && item.ref) || "").split(":")[2];
    return date ? `${meta.route}?date=${date}` : meta.route;
  }
  return meta.route;
}

/**
 * 按分组聚合来源明细，组内按优先级排序。
 * @param {Array<object|string>} list
 * @returns {Array<{kind:string,label:string,items:Array<object>}>}
 */
export function groupSourceRefs(list) {
  const buckets = new Map();
  for (const item of normalizeSourceRefs(list)) {
    const group = groupKeyFromKind(item.kind);
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(item);
  }
  return GROUP_ORDER.filter((group) => buckets.has(group)).map((group) => ({
    kind: group,
    label: GROUP_META[group].label,
    items: buckets.get(group).slice().sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
  }));
}
