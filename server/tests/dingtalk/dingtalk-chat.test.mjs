import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDingtalkChatService } from "../../integrations/dingtalk-chat.mjs";

const SCHEMA = `CREATE TABLE sync_state(key TEXT PRIMARY KEY,value_json TEXT);
  CREATE TABLE dingtalk_chat_conversations(id TEXT PRIMARY KEY,type TEXT,title TEXT,peer_user_id TEXT,peer_name TEXT,enabled INTEGER,retention_mode TEXT,last_message_at TEXT,sync_cursor_json TEXT,created_at TEXT,updated_at TEXT,chat_mode TEXT,is_bot INTEGER DEFAULT 0,type_known INTEGER DEFAULT 0,last_sync_json TEXT);
  CREATE TABLE dingtalk_chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT,sender_id TEXT,sender_name TEXT,direction TEXT,sent_at TEXT,message_type TEXT,content TEXT,mentioned_me INTEGER,mention_scope TEXT DEFAULT 'none',context_only INTEGER,context_root_id TEXT,quoted_message_id TEXT,raw_json TEXT,archive_path TEXT,processing_status TEXT,attachment_count INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT);
  CREATE TABLE dingtalk_message_analysis(message_id TEXT PRIMARY KEY,classification TEXT,summary TEXT,action_text TEXT,due_date TEXT,priority TEXT,confidence INTEGER,assignee_self INTEGER,ai_meta_json TEXT,todo_id TEXT,draft_title TEXT,draft_note TEXT,draft_priority TEXT,draft_due_date TEXT,draft_rationale TEXT,draft_generated_at TEXT,created_at TEXT,updated_at TEXT);
  CREATE TABLE work_links(id TEXT PRIMARY KEY,source_type TEXT,source_id TEXT,target_type TEXT,target_id TEXT,confidence INTEGER,reason TEXT,status TEXT,created_at TEXT,updated_at TEXT,UNIQUE(source_type,source_id,target_type,target_id));
  CREATE TABLE dingtalk_chat_attachments(id TEXT PRIMARY KEY,message_id TEXT,conversation_id TEXT,kind TEXT,name TEXT,mime_type TEXT,size_bytes INTEGER,ref_json TEXT,local_path TEXT,downloaded_at TEXT,download_error TEXT,created_at TEXT);
  CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,created_at TEXT,completed_at TEXT,source_type TEXT,source_id TEXT,project_id TEXT,assignee_id TEXT);
  CREATE TABLE work_signals(id TEXT PRIMARY KEY,title TEXT,classification TEXT,state TEXT,priority TEXT,confidence INTEGER,conclusion TEXT,facts_json TEXT,steps_json TEXT,draft_title TEXT,draft_note TEXT,draft_priority TEXT,draft_due_date TEXT,draft_rationale TEXT,todo_id TEXT,ai_meta_json TEXT,created_at TEXT,updated_at TEXT);
  CREATE TABLE work_signal_evidence(id TEXT PRIMARY KEY,signal_id TEXT,message_id TEXT,conversation_id TEXT,conversation_title TEXT,sender_name TEXT,sent_at TEXT,mention_scope TEXT,excerpt TEXT,is_root INTEGER,created_at TEXT,UNIQUE(signal_id,message_id));
  CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,progress INTEGER);`;

function memoryDb() { const db = new Database(":memory:"); db.exec(SCHEMA); return db; }

const CHATS = [
  { openConversationId: "dm1", conversationType: "direct", chatMode: "p2p", name: "张三" },
  { openConversationId: "g1", conversationType: "group", chatMode: "group", name: "项目群" },
  { openConversationId: "g2", conversationType: "group", chatMode: "group", name: "ERP 数据库预警群" },
];
const AT_ME_ITEMS = [
  {
    messageId: "g-mention", conversationId: "g1", conversation: { name: "项目群", openConversationId: "g1" },
    sender: "李四", text: "@Charles 请确认合同", time: "2026-08-20 09:00:00",
    resourceRefs: [{ resourceId: "@media-1", type: "mediaId", download: { ready: true, missing: [], arguments: { "resource-id": "@media-1", type: "mediaId", "message-id": "g-mention", "open-conversation-id": "g1" } } }],
  },
];
const PRIVATE_MESSAGES = [
  { messageId: "dm-message", sender: "张三", senderId: "u-zhang", createTime: "2026-08-20 08:00:00", content: "请处理合同", openConversationId: "dm1", conversationId: "dm1" },
  { messageId: "dm-reply", sender: "Charles", senderId: "u-me", createTime: "2026-08-20 08:30:00", content: "收到", openConversationId: "dm1", conversationId: "dm1" },
];
const GROUP_MESSAGES = [
  { messageId: "g-before", sender: "王五", createTime: "2026-08-20 08:59:00", content: "背景信息", conversationId: "g1" },
  { messageId: "g-mention", sender: "李四", createTime: "2026-08-20 09:00:00", content: "@Charles 请确认合同", conversationId: "g1" },
  { messageId: "g-after", sender: "赵六", createTime: "2026-08-20 09:01:00", content: "补充说明", conversationId: "g1" },
];

function makeRun(overrides = {}) {
  return async (args) => {
    if (args.includes("--help")) return overrides.help?.(args) ?? {};
    if (args[0] === "version") return { version: "1.0.60" };
    if (args[0] === "auth") return { connected: true, userName: "Charles", corpName: "睿翼" };
    if (args[0] === "profile") return { currentProfile: "corp:user", profiles: [] };
    if (args[1] === "+chat-list") return overrides.chatList ?? { chats: CHATS, complete: true, partial: false, hasMore: false, failedCount: 0, failures: [] };
    if (args[1] === "+at-me") return overrides.atMe ?? { items: AT_ME_ITEMS, complete: true, partial: false, hasMore: false, failedCount: 0, failures: [] };
    if (args[1] === "+chat-messages") {
      const target = args.includes("dm1") ? PRIVATE_MESSAGES : GROUP_MESSAGES;
      return overrides.messages?.(args, target) ?? { messages: target, complete: true, partial: false, hasMore: false, failedCount: 0, failures: [] };
    }
    if (args[1] === "+conversation-list") return overrides.conversationList ?? { conversations: [], complete: true };
    if (args[1] === "+chat-list-all") return overrides.chatListAll ?? { chats: [], complete: true };
    return {};
  };
}

async function makeService(overrides = {}, nowDate = "2026-08-21T00:00:00Z", aiService = null, managerUserId = undefined) {
  const db = memoryDb();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "dws-chat-"));
  const service = createDingtalkChatService({
    database: () => db, dataDir: folder, run: makeRun(overrides), now: () => new Date(nowDate),
    managerUserId, aiService: aiService || { async analyzeDingtalkMessage(msg) {
      return { classification: "action", summary: "确认合同", actionText: "确认合同并按流程流转", dueDate: "2026-08-25", priority: "P1", confidence: 80, assigneeSelf: true,
        draftTitle: "确认项目合同", draftNote: "核对合同条款并反馈", draftPriority: "P1", draftDueDate: "2026-08-25", draftRationale: "消息@我提出确认合同，属于需当前用户处理的工作事项" };
    } },
  });
  return { db, folder, service };
}

test("事项中心以配置的主管 ID 判定待回复，缺少配置时安全停用", async () => {
  const { db, folder, service } = await makeService({}, "2026-08-21T00:00:00Z", null, "u-me");
  await service.sync();
  assert.equal((await service.inbox()).replyPending.length, 0, "主管已回复后不应显示待回复");
  db.prepare("DELETE FROM dingtalk_chat_messages WHERE id='dm-reply'").run();
  const inbox = await service.inbox();
  assert.deepEqual(inbox.replyPending.map((item) => item.id), ["dm-message"]);
  const { db: secondDb, folder: secondFolder, service: noManager } = await makeService({}, "2026-08-21T00:00:00Z", null, null);
  assert.equal((await noManager.inbox()).ready, false);
  db.close(); secondDb.close(); await fs.rm(folder, { recursive: true, force: true }); await fs.rm(secondFolder, { recursive: true, force: true });
});

test("首次同步：私聊双向、群 @我 上下文、附件元数据、机器人标记全部就位且幂等", async () => {
  const { db, folder, service } = await makeService();
  const first = await service.sync();
  assert.equal(first.firstSync, true);
  assert.equal(first.partial, false, "全量 ledger 完整时不应标记 partial");
  assert.ok(first.complete);

  assert.equal(db.prepare("SELECT type FROM dingtalk_chat_conversations WHERE id='dm1'").get().type, "private");
  assert.equal(db.prepare("SELECT type FROM dingtalk_chat_conversations WHERE id='g1'").get().type, "group");
  assert.equal(db.prepare("SELECT title FROM dingtalk_chat_conversations WHERE id='g1'").get().title, "项目群");
  // 会话名带「预警」→ 识别为机器人噪声并降权
  assert.equal(db.prepare("SELECT is_bot FROM dingtalk_chat_conversations WHERE id='g2'").get().is_bot, 1);
  assert.equal(db.prepare("SELECT is_bot FROM dingtalk_chat_conversations WHERE id='g1'").get().is_bot, 0);

  // 私聊双向都在
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_messages WHERE conversation_id='dm1'").get().c, 2);
  // @我 根消息 + 前后上下文（上下文不触发 AI，context_only=1）
  const mention = db.prepare("SELECT * FROM dingtalk_chat_messages WHERE id='g-mention'").get();
  assert.ok(mention, "@我 根消息必须入库");
  assert.equal(mention.mentioned_me, 1);
  assert.equal(mention.context_only, 0);
  const contextRows = db.prepare("SELECT id FROM dingtalk_chat_messages WHERE context_root_id='g-mention' ORDER BY sent_at").all();
  assert.deepEqual(contextRows.map((r) => r.id), ["g-before", "g-after"]);
  // 附件只存元数据
  const attachment = db.prepare("SELECT * FROM dingtalk_chat_attachments WHERE message_id='g-mention'").get();
  assert.ok(attachment, "resourceRefs 应转成附件元数据行");
  assert.equal(attachment.kind, "mediaId");
  assert.ok(JSON.parse(attachment.ref_json).args["resource-id"] === "@media-1", "DWS 给的下载参数必须原样保留");

  assert.equal(service.settings().initialSyncComplete, true);

  // 重复同步：INSERT OR IGNORE + 水位线，任何对象都不重复
  const second = await service.sync();
  assert.equal(second.count, 0);
  assert.equal(second.firstSync, false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_messages").get().c, 5);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_attachments").get().c, 1);

  // 归档为幂等重建：两次同步后文件行数不增长
  const archiveRoot = path.join(folder, "dingtalk-messages");
  const files = await fs.readdir(path.join(archiveRoot, "private"), { recursive: true });
  const jsonl = files.filter((f) => String(f).endsWith(".jsonl"));
  assert.ok(jsonl.length >= 1, "私聊应落归档 JSONL");
  const body = await fs.readFile(path.join(archiveRoot, "private", jsonl[0]), "utf8");
  assert.match(body, /dm-message/);
  const lines = body.trim().split("\n");
  assert.equal(new Set(lines).size, lines.length, "归档不得出现重复行");

  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("部分成功：退出码非 0 但带数据 → 数据保留且标记 partial，不显示为完整", async () => {
  const { db, folder, service } = await makeService({
    chatList: { stdout: JSON.stringify({ chats: CHATS, complete: false, partial: true, hasMore: false, failedCount: 1, failures: [{ error: "分页失败", page: 1 }] }), exitCode: 1, stderr: "" },
  });
  const result = await service.sync();
  assert.equal(result.partial, true, "分页失败必须透出为部分成功");
  assert.equal(result.complete, false);
  assert.ok(result.problems.some((p) => p.scope === "conversations" && p.failedCount === 1));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_conversations").get().c, 3, "已取得的会话数据必须保留");
  const last = service.lastSync();
  assert.equal(last.partial, true);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("消息读取部分失败：上下文拉取异常不阻断根消息入库", async () => {
  const { db, folder, service } = await makeService({
    messages: (args, target) => {
      if (args.includes("g1")) return { stdout: JSON.stringify({ messages: GROUP_MESSAGES, complete: false, partial: true, failures: [{ error: "一页失败" }] }), exitCode: 1, stderr: "" };
      return { messages: target, complete: true };
    },
  });
  const result = await service.sync();
  assert.equal(result.partial, true);
  assert.ok(db.prepare("SELECT * FROM dingtalk_chat_messages WHERE id='g-mention'").get(), "根消息保留");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("保留期清理：过期消息删除、永久会话跳过、归档同步收缩", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  // 会话 g1 设为永久保留
  service.setConversation("g1", { retention_mode: "permanent" });
  // 把私聊消息时间挪到 400 天前（超过默认 180 天）
  db.prepare("UPDATE dingtalk_chat_messages SET sent_at='2025-01-01T00:00:00.000Z' WHERE conversation_id='dm1'").run();
  const purged = await service.cleanup();
  assert.ok(purged >= 2, `应清理 dm1 的历史消息，实际 ${purged}`);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_messages WHERE conversation_id='dm1'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dingtalk_chat_messages WHERE conversation_id='g1'").get().c, 3, "永久会话跳过清理");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("全局永久保留：cleanup 直接跳过", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  service.updateSettings({ permanent: true });
  db.prepare("UPDATE dingtalk_chat_messages SET sent_at='2025-01-01T00:00:00.000Z'").run();
  assert.equal(await service.cleanup(), 0);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("停用群：@我 不再入库，历史消息保留", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  service.setConversation("g1", { enabled: 0 });
  db.prepare("DELETE FROM dingtalk_chat_messages WHERE conversation_id='g1'").run();
  const result = await service.sync();
  assert.equal(result.count, 0, "停用群不得再采集");
  assert.ok(result.mentions === 0, "停用群不产生新的 @我 记录");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("启用群的 @所有人 作为根消息入库，并保留独立提及范围", async () => {
  const allMessage = { messageId: "g-all", sender: "项目经理", createTime: "2026-08-20 10:00:00", content: "@所有人 请今天确认排期影响", conversationId: "g1" };
  const { db, folder, service } = await makeService({ messages: (args, target) => ({ messages: args.includes("g1") ? [...GROUP_MESSAGES, allMessage] : target, complete: true }) });
  await service.sync();
  const row = db.prepare("SELECT mentioned_me,mention_scope,context_only FROM dingtalk_chat_messages WHERE id='g-all'").get();
  assert.deepEqual(row, { mentioned_me: 0, mention_scope: "all", context_only: 0 });
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("测试场景写入持久化工作信号，确认待办按信号幂等", async () => {
  const { db, folder, service } = await makeService();
  service.injectTestScenario();
  const signals = service.listSignals();
  assert.deepEqual(signals.counts, { priority: 1, confirm: 2, know: 1 });
  const first = service.confirmSignalDraft("demo_work_signal_schedule", {});
  const second = service.confirmSignalDraft("demo_work_signal_schedule", {});
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM todos WHERE source_type='dingtalk_signal'").get().count, 1);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("清理测试场景只删除 demo 记录，不影响真实消息", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  service.injectTestScenario();
  const result = service.clearTestScenario();
  assert.equal(db.prepare("SELECT COUNT(*) count FROM work_signals WHERE id LIKE 'demo_work_signal_%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM dingtalk_chat_messages WHERE id LIKE 'demo_signal_%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM dingtalk_chat_messages WHERE id='dm-message'").get().count, 1);
  assert.equal(result.removed.todos, 0);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("消息状态：忽略与仅供知晓受支持，非法状态拒绝", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  assert.equal(service.setMessageStatus("dm-message", "ignored").processing_status, "ignored");
  assert.equal(service.setMessageStatus("dm-reply", "informational").processing_status, "informational");
  assert.throws(() => service.setMessageStatus("dm-message", "bogus"), /不支持的消息状态/);
  const counts = service.countByStatus();
  assert.equal(counts.ignored, 1);
  assert.equal(counts.informational, 1);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("status 不透出 DWS 原始认证对象", async () => {
  const { db, folder, service } = await makeService();
  const detail = await service.status();
  assert.equal(detail.auth, undefined, "不得原样回传 auth 对象");
  assert.equal(detail.account.user, "Charles");
  assert.equal(detail.account.org, "睿翼");
  assert.equal(detail.capabilities.coreReady, true);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("能力探测临时失败时保留最近一次成功同步的能力", async () => {
  let helpAvailable = true;
  const { db, folder, service } = await makeService({
    help: () => helpAvailable ? {} : { stdout: "", exitCode: 1 },
  });
  await service.sync();
  helpAvailable = false;
  const detail = await service.status({ force: true });
  assert.equal(detail.capabilities.coreReady, true);
  assert.equal(detail.capabilities.probeFallback, true);
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("DWS 状态快照不启动命令，缓存命中与强制刷新行为正确", async () => {
  let calls = 0;
  const db = memoryDb();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "dws-chat-"));
  const run = async (args) => {
    calls += 1;
    if (args[0] === "version") return { version: "1.0.60" };
    if (args[0] === "auth") return { connected: true };
    if (args[0] === "profile") return { currentProfile: "corp:user" };
    return {};
  };
  const service = createDingtalkChatService({ database: () => db, dataDir: folder, run });
  assert.equal(service.statusSnapshot().checking, true);
  await service.status({ probeCapabilities: false });
  assert.equal(calls, 3);
  await service.status({ probeCapabilities: false });
  assert.equal(calls, 3, "缓存命中不得再次启动 DWS 命令");
  await service.status({ probeCapabilities: false, force: true });
  assert.equal(calls, 6, "强制刷新必须重新探测");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("会话列表支持服务端范围筛选、搜索与分页", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  service.setConversation("dm1", { retention_mode: "permanent" });
  const first = service.listConversations({ scope: "groups_or_permanent", limit: 1, offset: 0 });
  assert.equal(first.total, 3);
  assert.equal(first.items.length, 1);
  const search = service.listConversations({ scope: "groups_or_permanent", q: "项目" });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, "g1");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("消息详情：上下文来自同一根消息，附件与关联一并返回", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  const detail = service.message("g-mention");
  assert.ok(detail);
  assert.deepEqual(detail.context.map((c) => c.id), ["g-before", "g-after"]);
  assert.equal(detail.attachments.length, 1);
  // 人为插入一条建议关联，验证返回结构
  db.prepare("INSERT INTO work_links(id,source_type,source_id,target_type,target_id,confidence,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("wl1", "dingtalk_message", "g-mention", "project", "p1", 92, "标题匹配", "auto", "2026-08-21T00:00:00Z", "2026-08-21T00:00:00Z");
  assert.equal(service.message("g-mention").links.length, 1);
  // 撤销自动关联（auto → rejected），PRD 要求所有自动关联可撤销
  assert.equal(service.setLink("wl1", "rejected").status, "rejected");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("转待办：幂等，且重复调用返回同一待办", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  const first = service.createTodo("g-mention");
  const second = service.createTodo("g-mention");
  assert.equal(first.id, second.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM todos WHERE source_type='dingtalk_message'").get().c, 1);
  assert.equal(service.message("g-mention").processing_status, "task_created");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("降级链：+chat-list 不可用时用 +chat-list-all ∪ +conversation-list 拼出群类型", async () => {
  const run = async (args) => {
    if (args.includes("--help")) return args[1] === "+chat-list" ? { stdout: "usage: ...", exitCode: 1 } : {};
    if (args[0] === "version") return { version: "1.0.60" };
    if (args[0] === "auth") return { connected: true };
    if (args[0] === "profile") return { currentProfile: "corp:user" };
    if (args[1] === "+conversation-list") return { conversations: [
      { openConversationId: "dm1", conversationName: "张三" },
      { openConversationId: "g1", conversationName: "项目群" },
    ], complete: true };
    if (args[1] === "+chat-list-all") return { chats: [{ openConversationId: "g1", name: "项目群" }], complete: true };
    if (args[1] === "+at-me") return { items: AT_ME_ITEMS, complete: true };
    if (args[1] === "+chat-messages") return { messages: GROUP_MESSAGES, complete: true };
    return {};
  };
  const db = memoryDb();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "dws-chat-"));
  const service = createDingtalkChatService({ database: () => db, dataDir: folder, run, now: () => new Date("2026-08-21T00:00:00Z") });
  await service.sync();
  assert.equal(db.prepare("SELECT type FROM dingtalk_chat_conversations WHERE id='g1'").get().type, "group");
  assert.equal(db.prepare("SELECT type FROM dingtalk_chat_conversations WHERE id='dm1'").get().type, "private");
  assert.ok(db.prepare("SELECT * FROM dingtalk_chat_messages WHERE id='g-mention'").get(), "降级链下 @我 仍要入库");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("待办草稿：AI 生成并缓存，重复调用不重复生成", async () => {
  let calls = 0;
  const aiService = { async analyzeDingtalkMessage() {
    calls += 1;
    return { classification: "action", summary: "s", actionText: "a", dueDate: null, priority: "P1", confidence: 80, assigneeSelf: true, draftTitle: "标题", draftNote: "说明", draftPriority: "P1", draftDueDate: "2026-08-25", draftRationale: "依据" };
  } };
  const { db, folder, service } = await makeService({}, "2026-08-21T00:00:00Z", aiService);
  await service.sync();
  const first = await service.generateTodoDraft("g-mention");
  assert.equal(first.cached, false);
  assert.equal(first.item.draft_title, "标题");
  assert.equal(first.item.draft_rationale, "依据");
  const analysis = db.prepare("SELECT * FROM dingtalk_message_analysis WHERE message_id='g-mention'").get();
  assert.ok(analysis.draft_generated_at, "应记录生成时间");
  const second = await service.generateTodoDraft("g-mention");
  assert.equal(second.cached, true, "已生成过则返回缓存");
  assert.equal(calls, 1, "不得重复调用 AI");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("确认创建待办：写入用户编辑草稿且幂等，重复确认返回同一待办", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  const r1 = service.confirmTodoDraft("g-mention", { title: "最终标题", note: "要点A", priority: "P1", dueDate: "2026-08-30", rationale: "用户确认" });
  assert.equal(r1.created, true);
  assert.equal(r1.todo.title, "最终标题");
  assert.match(r1.todo.note, /要点A/);
  assert.match(r1.todo.note, /生成依据/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM todos WHERE source_type='dingtalk_message'").get().c, 1);
  const r2 = service.confirmTodoDraft("g-mention", { title: "最终标题" });
  assert.equal(r2.created, false);
  assert.equal(r2.todo.id, r1.todo.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM todos WHERE source_type='dingtalk_message'").get().c, 1);
  assert.equal(service.message("g-mention").processing_status, "task_created");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});

test("行动箱过滤：默认「全部」不含上下文/仅供知晓/已过滤", async () => {
  const { db, folder, service } = await makeService();
  await service.sync();
  service.setMessageStatus("dm-reply", "informational");
  db.prepare("UPDATE dingtalk_chat_messages SET context_only=1 WHERE id IN ('g-before','g-after')").run();
  const ids = service.listMessages().map((m) => m.id);
  assert.ok(!ids.includes("g-before") && !ids.includes("g-after"), "上下文消息不进入行动列表");
  assert.ok(!ids.includes("dm-reply"), "仅供知晓不进入默认全部");
  assert.ok(ids.includes("g-mention") && ids.includes("dm-message"), "行动项正常出现");
  assert.equal(service.countByStatus().total, 2, "全部计数只含可行动消息");
  db.close(); await fs.rm(folder, { recursive: true, force: true });
});
