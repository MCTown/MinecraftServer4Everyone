import { getSqlite } from "../db/client.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export interface InboxItem {
  id: string;
  scopeId: string;
  kind: "user" | "synthetic" | "compaction";
  delivery: "steer" | "queue";
  text: string;
  createdAt: string;
  enqueuedSeq?: number;
  state?: "pending" | "delivered" | "cancelled";
  sourceJobId?: string;
  sourceTurnId?: string;
  deliveredTurnId?: string;
  claimedTurnId?: string;
  cancelled?: boolean;
  /** Admission without execution (e.g. restart notices) must not wake an idle owner. */
  resume?: boolean;
  controlResult?: { compressed: number };
  controlError?: string;
  handoffParentTurnId?: string;
  requestOptions?: { reasoningEffort: string; benchmarkMode?: "full" | "basic" };
}

/** Durable admission is separate from model-visible delivery. All mutations are
 * synchronous transactions so an event and its projection cannot diverge. */
export class InboxStore {
  events(scopeId: string, after = 0, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("无效的事件 cursor/limit");
    return (getSqlite().prepare("SELECT seq,inbox_id AS inboxId,kind,payload FROM agent_inbox_events WHERE scope_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(scopeId, after, limit) as { seq: number; inboxId: string; kind: string; payload: string }[])
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) as InboxItem }));
  }

  private event(item: InboxItem, kind: string) {
    return Number(getSqlite().prepare("INSERT INTO agent_inbox_events(inbox_id,scope_id,kind,payload) VALUES (?,?,?,?)")
      .run(item.id, item.scopeId, kind, JSON.stringify(item)).lastInsertRowid);
  }

  get(id: string): InboxItem | undefined {
    const row = getSqlite().prepare("SELECT payload, state FROM agent_inbox WHERE id=?").get(id) as { payload: string; state: InboxItem["state"] } | undefined;
    return row ? { ...JSON.parse(row.payload), state: row.state } : undefined;
  }

  list(scopeId: string, pendingOnly = true): InboxItem[] {
    return (getSqlite().prepare(`SELECT payload,state FROM agent_inbox WHERE scope_id=? ${pendingOnly ? "AND state='pending'" : ""}
      ORDER BY COALESCE(json_extract(payload,'$.enqueuedSeq'),rowid),rowid`)
      .all(scopeId) as { payload: string; state: InboxItem["state"] }[])
      .map((row) => ({ ...JSON.parse(row.payload), state: row.state }));
  }

  admit(input: Omit<InboxItem, "id" | "createdAt" | "state"> & { id?: string }): InboxItem {
    return getSqlite().transaction(() => {
      const id = input.id ?? createId("inbox");
      const existing = this.get(id);
      if (existing) {
        if (existing.scopeId !== input.scopeId || existing.kind !== input.kind) throw new Error("Inbox ID 已被其他会话或输入类型使用");
        // First admission wins, including metadata and delivery, even after delivery/cancellation.
        return existing;
      }
      const item: InboxItem = { ...input, id, createdAt: nowIso(), state: "pending" };
      item.enqueuedSeq = this.event(item, "enqueued");
      getSqlite().prepare("INSERT INTO agent_inbox(id,scope_id,state,payload) VALUES (?,?,'pending',?)")
        .run(id, item.scopeId, JSON.stringify(item));
      return item;
    })();
  }

  private mutate(scopeId: string, id: string, kind: string, change: (item: InboxItem) => void) {
    return getSqlite().transaction(() => {
      const item = this.get(id);
      if (!item || item.scopeId !== scopeId || item.state !== "pending") return undefined;
      change(item);
      getSqlite().prepare("UPDATE agent_inbox SET state=?,payload=? WHERE id=? AND scope_id=? AND state='pending'")
        .run(item.state, JSON.stringify(item), id, scopeId);
      this.event(item, kind);
      return item;
    })();
  }

  delivery(scopeId: string, id: string, delivery: InboxItem["delivery"]) {
    return this.mutate(scopeId, id, "delivery.changed", (item) => { item.delivery = delivery; if (delivery === "steer") item.resume = true; });
  }

  pause(scopeId: string, id: string) {
    return this.mutate(scopeId, id, "delivery.changed", (item) => { item.delivery = "queue"; item.resume = false; });
  }

  cancel(scopeId: string, id: string) {
    return this.mutate(scopeId, id, "cancelled", (item) => { item.state = "cancelled"; item.cancelled = true; });
  }

  delivered(scopeId: string, id: string, turnId: string) {
    return this.mutate(scopeId, id, "delivered", (item) => { item.state = "delivered"; item.deliveredTurnId = turnId; });
  }

  bind(scopeId: string, id: string, turnId: string) {
    return this.mutate(scopeId, id, "claimed", (item) => { item.claimedTurnId = turnId; });
  }

  controlOutcome(item: InboxItem, result: { compressed: number } | string) {
    return this.mutate(item.scopeId, item.id, "control.ended", (entry) => {
      if (typeof result === "string") entry.controlError = result;
      else entry.controlResult = result;
    });
  }

  /** Upgrade legacy rows once, retaining their original insertion order. */
  migrate() {
    getSqlite().transaction(() => {
      const rows = getSqlite().prepare("SELECT id,payload,state FROM agent_inbox ORDER BY rowid").all() as { id: string; payload: string; state: InboxItem["state"] }[];
      for (const row of rows) {
        const item: InboxItem = { ...JSON.parse(row.payload), state: row.state };
        if (item.enqueuedSeq !== undefined) continue;
        item.enqueuedSeq = this.event(item, "migrated");
        getSqlite().prepare("UPDATE agent_inbox SET payload=? WHERE id=?").run(JSON.stringify(item), row.id);
      }
    })();
  }

  /** Steer is batched at step boundaries; queue is one-at-a-time at idle boundaries. */
  select(scopeId: string, idle: boolean, eligible: (item: InboxItem) => boolean = () => true) {
    const items = this.list(scopeId).filter(eligible);
    const steer = items.filter((item) => item.delivery === "steer");
    if (!steer.length) return idle ? items.filter((item) => item.delivery === "queue").slice(0, 1) : [];
    const control = steer.findIndex((item) => item.kind === "compaction");
    // Earlier inputs deliver first; a control is processed alone. Later steers
    // cannot cross its history-replacement boundary.
    return control < 0 ? steer : control === 0 ? steer.slice(0, 1) : steer.slice(0, control);
  }
}
