import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { appConfig } from "../src/config.js";
import { getSqlite, initDatabase } from "../src/db/client.js";
import { InboxStore } from "../src/agent/inboxStore.js";

let root: string;
before(async () => { root = await mkdtemp("/tmp/opencode/inbox-store-"); appConfig.dataDir = root; initDatabase(); });
after(async () => { getSqlite().close(); await rm(root, { recursive: true, force: true }); });

test("first admission wins after pending, delivery and cancellation; cross-type/scope reuse conflicts", () => {
  const store = new InboxStore();
  const input = { id: "identity", scopeId: "owner", kind: "user" as const, text: "first", delivery: "queue" as const };
  const first = store.admit(input);
  assert.ok(first.enqueuedSeq! > 0);
  assert.deepEqual(store.admit({ ...input, text: "changed", delivery: "steer", resume: true }), first);
  assert.throws(() => store.admit({ ...input, scopeId: "other" }), /其他会话/);
  assert.throws(() => store.admit({ ...input, kind: "synthetic" }), /输入类型/);
  store.delivered("other", first.id, "wrong");
  assert.equal(store.get(first.id)!.state, "pending");
  store.delivered("owner", first.id, "turn");
  assert.equal(store.admit(input).deliveredTurnId, "turn");
  store.cancel("owner", first.id);
  assert.equal(store.get(first.id)!.state, "delivered");
  const cancelled = store.admit({ ...input, id: "cancelled" });
  store.cancel("owner", cancelled.id);
  assert.equal(store.admit({ ...input, id: cancelled.id }).state, "cancelled");
});

test("steer batches stop at controls; idle queue delivers one item and never preempts steer", () => {
  const store = new InboxStore(), scopeId = "boundaries";
  const add = (id: string, kind: "synthetic" | "compaction", delivery: "steer" | "queue") => store.admit({ id, kind, delivery, scopeId, text: id });
  add("q1", "synthetic", "queue"); add("q2", "synthetic", "queue");
  add("s1", "synthetic", "steer"); add("compact", "compaction", "steer"); add("s2", "synthetic", "steer");
  assert.deepEqual(store.select(scopeId, true).map((item) => item.id), ["s1"]);
  store.delivered(scopeId, "s1", "t");
  assert.deepEqual(store.select(scopeId, true).map((item) => item.id), ["compact"]);
  store.delivered(scopeId, "compact", "t"); store.delivered(scopeId, "s2", "t");
  assert.deepEqual(store.select(scopeId, false), []);
  assert.deepEqual(store.select(scopeId, true).map((item) => item.id), ["q1"]);
  store.delivered(scopeId, "q1", "t");
  assert.deepEqual(store.select(scopeId, true).map((item) => item.id), ["q2"]);
});

test("admission events and projections roll back together, legacy migration is ordered and idempotent", () => {
  const store = new InboxStore();
  assert.throws(() => getSqlite().transaction(() => {
    store.admit({ id: "rolled-back", scopeId: "atomic", kind: "synthetic", delivery: "steer", text: "no" });
    throw new Error("rollback");
  })());
  assert.equal(store.get("rolled-back"), undefined);
  assert.equal((getSqlite().prepare("SELECT count(*) AS n FROM agent_inbox_events WHERE inbox_id='rolled-back'").get() as { n: number }).n, 0);
  for (const id of ["old1", "old2"]) getSqlite().prepare("INSERT INTO agent_inbox VALUES (?,?,'pending',?)")
    .run(id, "legacy", JSON.stringify({ id, scopeId: "legacy", kind: "synthetic", text: id, delivery: "steer" }));
  store.migrate(); store.migrate();
  const [first, second] = store.list("legacy");
  assert.ok(first!.enqueuedSeq! < second!.enqueuedSeq!);
  assert.equal((getSqlite().prepare("SELECT count(*) AS n FROM agent_inbox_events WHERE scope_id='legacy'").get() as { n: number }).n, 2);
});
