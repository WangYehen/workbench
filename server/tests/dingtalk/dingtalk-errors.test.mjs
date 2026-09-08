import test from "node:test";
import assert from "node:assert/strict";
import { classifyDingtalkFailure, DINGTALK_IP_NOT_WHITELISTED } from "../../integrations/dingtalk.mjs";

test("钉钉白名单错误码会被标记为永久阻断", () => {
  const result = classifyDingtalkFailure({ code: 60020, message: "access ip 203.0.113.8 is not in white list" });
  assert.equal(result.code, DINGTALK_IP_NOT_WHITELISTED);
  assert.equal(result.blocked, true);
  assert.equal(result.retryable, false);
  assert.equal(result.egressIp, "203.0.113.8");
});

test("普通钉钉网络错误仍允许自动重试", () => {
  const result = classifyDingtalkFailure({ httpStatus: 503, message: "service unavailable" });
  assert.equal(result.code, "DINGTALK_HTTP_503");
  assert.equal(result.blocked, false);
  assert.equal(result.retryable, true);
});
