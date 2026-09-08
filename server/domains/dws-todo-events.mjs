import { spawn } from "node:child_process";
import { config } from "../config.mjs";
import { getDb } from "../db.mjs";
import { createTodoSyncService } from "./todo-sync.mjs";

// Long-lived DWS todo event consumer. Each JSON line is handled independently;
// malformed lines are ignored so one CLI diagnostic cannot stop the stream.
export function createDwsTodoEventService({ database = getDb, dwsClient, executable = config.dws.executable, spawnProcess = spawn } = {}) {
  const sync = createTodoSyncService({ database, dwsClient });
  let child = null;
  let stopped = false;
  let reconnectTimer = null;
  function state(patch) {
    const db = database();
    db.prepare("INSERT INTO sync_state(key,value_json) VALUES('dws_todo_events',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify({ ...(readState(db) || {}), ...patch }));
  }
  function readState(db) { try { return JSON.parse(db.prepare("SELECT value_json FROM sync_state WHERE key='dws_todo_events'").get()?.value_json || "{}"); } catch { return {}; } }
  async function handle(event) {
    if (!event || typeof event !== "object") return { ignored: true, reason: "invalid_event" };
    const id = event.eventId || event.id || event.event_id;
    const db = database();
    if (id && db.prepare("SELECT 1 FROM dws_todo_event_log WHERE event_id=?").get(String(id))) return { ignored: true, reason: "duplicate_event" };
    const result = await sync.syncFromDingtalk(event);
    if (id) db.prepare("INSERT INTO dws_todo_event_log(event_id,payload_json,handled_at) VALUES(?,?,?)").run(String(id), JSON.stringify({ taskId: event.taskId || event.task_id || event.data?.taskId, status: event.status, isDone: event.isDone }), new Date().toISOString());
    state({ lastEventId: id || null, lastEventAt: new Date().toISOString(), lastResult: result.reason || "handled" });
    return result;
  }
  function scheduleReconnect() { if (!stopped && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, 60000); }
  function start() {
    stopped = false;
    if (child) return;
    child = spawnProcess(executable, ["event", "consume", "--category", "todo", "--format", "json"], { shell: false, windowsHide: true });
    let buffer = "";
    child.stdout.on("data", (chunk) => { buffer += String(chunk); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { try { void handle(JSON.parse(line)); } catch { /* ignore CLI logs */ } } });
    child.on("close", () => { child = null; state({ status: stopped ? "stopped" : "reconnecting" }); scheduleReconnect(); });
    child.on("error", (error) => { state({ status: "waiting", error: error.message }); });
    state({ status: "running", startedAt: new Date().toISOString() });
  }
  function stop() { stopped = true; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; child?.kill(); child = null; state({ status: "stopped" }); }
  return { start, stop, handle };
}
