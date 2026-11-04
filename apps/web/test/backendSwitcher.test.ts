import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { ref } from "vue";

const source = readFileSync(new URL("../components/dialogs/BackendSwitcherDialog.vue", import.meta.url), "utf8");
const script = parse(source).descriptor.scriptSetup!.content;
const ast = ts.createSourceFile("switcher.ts", script, ts.ScriptTarget.Latest, true);
const handlers = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["resetForm", "close", "createNode", "confirmRemoval"].includes(node.name?.text ?? ""))
  .map((node) => node.getText(ast)).join("\n");

function harness(options: { add?: (input: unknown) => Promise<unknown>; remove?: (id: string) => Promise<unknown>; canLeave?: boolean; nodeId?: string } = {}) {
  const events: unknown[][] = [];
  const state = {
    props: { nodeId: options.nodeId ?? "current", beforeRemove: () => options.canLeave !== false },
    loading: ref(false), saving: ref(false), mutationError: ref(""), notice: ref(""), showAdd: ref(true),
    form: { name: " New backend ", url: " http://10.0.0.11:8787 ", accessKey: "private-input" },
    removing: ref<{ id: string; name: string } | null>({ id: options.nodeId ?? "current", name: "Current" }),
    dialog: ref(null), addButton: ref(null),
    add: options.add ?? (async () => ({ id: "new", name: "New backend" })),
    remove: options.remove ?? (async () => ({ defaultNodeId: "fallback", nodes: [] })),
    emit: (...args: unknown[]) => { events.push(args); },
    load: async () => {}, nextTick: async (fn: () => void) => { fn(); }
  };
  const js = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions = new Function(...Object.keys(state), `let generation = 0; ${js}; return {createNode, confirmRemoval, close};`)(...Object.values(state));
  return { ...state, ...actions, events };
}

test("node creation locks duplicate submissions and close; secrets are cleared after saving", async () => {
  let resolve!: (value: unknown) => void;
  const requests: unknown[] = [];
  const state = harness({ add: (input) => { requests.push(input); return new Promise((yes) => { resolve = yes; }); } });
  const creating = state.createNode();
  assert.equal(state.saving.value, true);
  await state.createNode();
  state.close();
  assert.equal(state.events.length, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { name: "New backend", url: "http://10.0.0.11:8787", accessKey: "private-input" });
  resolve({ id: "new", name: "New backend" });
  await creating;
  assert.equal(state.saving.value, false);
  assert.equal(state.showAdd.value, false);
  assert.equal(state.form.accessKey, "");
  assert.ok(!state.notice.value.includes("private-input"));
});

test("first added node is selected, failure stays retryable, and closing discards the secret", async () => {
  const initial = harness({ nodeId: "" });
  await initial.createNode();
  assert.deepEqual(initial.events, [["select", "new"]]);
  const failed = harness({ add: async () => { throw { data: { error: "存储不可写" } }; } });
  failed.loading.value = true;
  await failed.createNode();
  assert.equal(failed.saving.value, false);
  assert.equal(failed.loading.value, false, "invalidated status checks must not leave refresh disabled after failure");
  assert.equal(failed.showAdd.value, true);
  assert.equal(failed.mutationError.value, "存储不可写");
  failed.close();
  assert.equal(failed.form.accessKey, "");
  assert.deepEqual(failed.events, [["close"]]);
});

test("node removal checks leave safety before sending and only navigates after a confirmed save", async () => {
  let requests = 0;
  const denied = harness({ canLeave: false, remove: async () => { requests++; } });
  await denied.confirmRemoval();
  assert.equal(requests, 0);
  assert.equal(denied.events.length, 0);
  const accepted = harness();
  await accepted.confirmRemoval();
  assert.deepEqual(accepted.events, [["removed", "current", "fallback"]]);
  assert.equal(accepted.removing.value, null);
  const failed = harness({ remove: async () => { throw { data: { error: "磁盘已满" } }; } });
  failed.loading.value = true;
  await failed.confirmRemoval();
  assert.equal(failed.events.length, 0);
  assert.equal(failed.removing.value?.id, "current");
  assert.equal(failed.saving.value, false);
  assert.equal(failed.loading.value, false);
  assert.equal(failed.mutationError.value, "磁盘已满");
});
