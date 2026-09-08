import test from "node:test";
import assert from "node:assert/strict";
import { createDwsClient } from "./dws-client.mjs";

function client(run) { return createDwsClient({ run, now: () => new Date("2026-09-01T00:00:00.000Z") }); }

test("DWS client 保留部分读取结果的 ledger", async () => {
  const api = client(async () => ({ items: [{ id: "1" }], complete: false, partial: true, failures: [{ page: 2 }] }));
  const result = await api.read(["todo", "task", "list"]);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.ledger.partial, true);
  assert.equal(result.ledger.complete, false);
  assert.equal(result.ledger.failures.length, 1);
});

test("DWS client 可解析 DWS 输出的多行 JSON", async () => {
  const api = createDwsClient({ run: async () => ({ stdout: "{\n  \"authenticated\": true\n}", stderr: "", exitCode: 0 }) });
  const result = await api.read(["auth", "status"]);
  assert.equal(result.data.authenticated, true);
});

test("DWS client 只接受明确的当前 profile", async () => {
  const api = client(async (args) => args[0] === "profile" ? { profiles: [{ id: "a" }, { id: "b" }] } : {});
  await assert.rejects(api.currentProfile(), { code: "DWS_PROFILE_AMBIGUOUS" });
});

test("未连接状态不会缓存，完成登录后下一次检测立即恢复", async () => {
  let authChecks = 0;
  const api = client(async (args) => {
    if (args[0] === "auth") return { authenticated: ++authChecks > 1 };
    if (args[0] === "profile") return { profiles: [{ id: "p1", isOrgCurrent: true, corpName: "组织", userName: "用户" }] };
    if (args[0] === "version") return { version: "1.0.0" };
    return {};
  });
  assert.equal((await api.status()).connected, false);
  assert.equal((await api.status()).connected, true);
  assert.equal(authChecks, 2);
});

test("DWS client 执行前必须预览并确认", async () => {
  const api = client(async () => ({}));
  await assert.rejects(api.executeConfirmed("todo.assign", {}, {}), { code: "DWS_CONFIRMATION_REQUIRED" });
  const preview = api.preview("todo.assign", { title: "跟进排期" });
  const result = await api.executeConfirmed("todo.assign", {}, { previewId: preview.id, idempotencyKey: "key-1", confirmed: true });
  assert.equal(result.executed, false);
  assert.equal(result.payload.title, "跟进排期");
});
