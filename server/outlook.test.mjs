import test from "node:test";
import assert from "node:assert/strict";
import { replaceStateFile } from "./outlook.mjs";

test("Outlook 状态文件替换会重试 Windows 的临时占用错误", async () => {
  const retryableCodes = ["EPERM", "EBUSY", "EACCES"];

  for (const code of retryableCodes) {
    let attempts = 0;
    const waits = [];
    await replaceStateFile("temporary", "state.enc.json", {
      renameFile: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error(code), { code });
      },
      wait: async (delay) => waits.push(delay),
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [25]);
  }
});

test("Outlook 状态文件替换不会掩盖非占用错误", async () => {
  const original = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  let waited = false;

  await assert.rejects(
    replaceStateFile("temporary", "state.enc.json", {
      renameFile: async () => { throw original; },
      wait: async () => { waited = true; },
    }),
    (error) => error === original,
  );
  assert.equal(waited, false);
});
