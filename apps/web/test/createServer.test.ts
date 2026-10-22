import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createSSRApp, ref } from "vue";
import { renderToString } from "@vue/server-renderer";

const page = readFileSync(new URL("../pages/index.vue", import.meta.url), "utf8");
const script = parse(page).descriptor.scriptSetup!.content;
const ast = ts.createSourceFile("index.ts", script, ts.ScriptTarget.Latest, true);
const handlers = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["createServer", "openCreateServerDialog", "closeCreateServerDialog"].includes(node.name?.text ?? ""))
  .map((node) => node.getText(ast)).join("\n");

function harness(api: () => Promise<unknown>, selectServer = async (_id: string) => {}) {
  const state = {
    newServerName: ref(" Test "), creatingServer: ref(false), createServerError: ref(""),
    createDialogOpen: ref(true), servers: ref<unknown[]>([]), api, selectServer,
    getErrorMessage: (error: Error) => error.message,
    showStatusBubble: (...args: unknown[]) => { bubbles.push(args); }
  };
  const bubbles: unknown[][] = [];
  const js = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions = new Function(...Object.keys(state), `${js}; return {createServer, openCreateServerDialog, closeCreateServerDialog};`)(...Object.values(state));
  return { ...state, ...actions, bubbles };
}

test("creation locks immediately, ignores duplicate submissions, and prevents dismissal", async () => {
  let resolve!: (server: { id: string }) => void;
  let requests = 0;
  const state = harness(() => { requests++; return new Promise((yes) => { resolve = yes; }); });
  const pending = state.createServer();
  assert.equal(state.creatingServer.value, true);
  await state.createServer();
  state.closeCreateServerDialog();
  state.openCreateServerDialog();
  assert.equal(state.createDialogOpen.value, true);
  assert.equal(state.newServerName.value, " Test ");
  assert.equal(requests, 1);
  resolve({ id: "new" });
  await pending;
  assert.equal(state.creatingServer.value, false);
  assert.equal(state.createDialogOpen.value, false);
  assert.equal(state.servers.value.length, 1);
});

test("creation failure stays in the dialog and unlocks for retry", async () => {
  const state = harness(async () => { throw new Error("disk full"); });
  await state.createServer();
  assert.equal(state.creatingServer.value, false);
  assert.equal(state.createDialogOpen.value, true);
  assert.match(state.createServerError.value, /disk full/);
  assert.equal(state.servers.value.length, 0);
  state.openCreateServerDialog();
  assert.equal(state.createServerError.value, "");
});

test("console loading failure does not turn successful creation into a retryable POST", async () => {
  const state = harness(async () => ({ id: "new" }), async () => { throw new Error("offline"); });
  await state.createServer();
  assert.equal(state.createDialogOpen.value, false);
  assert.equal(state.createServerError.value, "");
  assert.equal(state.servers.value.length, 1);
  assert.equal(state.creatingServer.value, false);
  assert.match(String(state.bubbles[0]), /实例已创建.*offline/);
});

test("dialog renders disabled controls and a spinning loader while creating", async () => {
  const source = readFileSync(new URL("../components/dialogs/CreateServerDialog.vue", import.meta.url), "utf8");
  const compiled = compileScript(parse(source).descriptor, { id: "create-dialog", inlineTemplate: true });
  const js = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const vue = await import("vue");
  const exports: Record<string, any> = {};
  new Function("require", "exports", js)((name: string) => {
    assert.equal(name, "vue");
    return vue;
  }, exports);
  async function render(creating: boolean, error = "") {
    const app = createSSRApp(exports.default, { open: true, name: "Test", creating, error });
    app.component("AppIcon", { props: ["name", "spin"], template: '<i :data-icon="name" :data-spin="spin" />' });
    return renderToString(app);
  }
  const busy = await render(true);
  assert.equal((busy.match(/ disabled/g) ?? []).length, 3);
  assert.match(busy, /data-icon="loader" data-spin="true"/);
  assert.match(busy, /正在创建/);
  assert.match(busy, /aria-busy="true"/);
  const failed = await render(false, "创建失败：disk full");
  assert.doesNotMatch(failed, / disabled/);
  assert.match(failed, /role="alert"[^>]*>创建失败：disk full/);
});
