// Run against a disposable workspace, never a real deployment configuration.
// WORKFLOW_TEST_URL=http://127.0.0.1:1148 WORKFLOW_TEST_PASSWORD=workflow-test \
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-deployment-workflow.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const url = process.env.WORKFLOW_TEST_URL;
if (!url || !process.env.WORKFLOW_TEST_PASSWORD) throw new Error("Set WORKFLOW_TEST_URL and WORKFLOW_TEST_PASSWORD for a disposable workspace.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const auth = await (await context.request.post(`${url}/api/auth/login`, { data: { password: process.env.WORKFLOW_TEST_PASSWORD } })).json();
await context.addCookies([{ name: "mcsa_token", value: auth.token, url }]);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("/tmp/opencode/workflow-browser", { recursive: true });
const apiPath = `${url}/api/settings/deployment-workflow`;
const original = await (await context.request.get(apiPath)).json();

async function openEditor(target = page) {
  await target.goto(url, { waitUntil: "domcontentloaded" });
  await target.waitForFunction(() => !!document.querySelector("#__nuxt")?.__vue_app__);
  await target.locator('.settings-panel,button[aria-label="全局设置"]').first().waitFor();
  if (!await target.locator(".settings-panel").count()) await target.getByRole("button", { name: "全局设置", exact: true }).click();
  await target.locator(".settings-nav-item").filter({ hasText: "流程编排" }).click();
  await target.locator(".workflow-canvas").waitFor();
  await target.waitForFunction(() => !document.querySelector(".workflow-prompt-text")?.classList.contains("stale"));
}
const node = (id, target = page) => target.locator(`[data-workflow-node="${id}"]`);
const port = (id, name, target = page) => node(id, target).locator(`[data-workflow-port="${name}"]`);
async function ids() { return page.locator("[data-workflow-node]").evaluateAll((elements) => elements.map((el) => el.dataset.workflowNode)); }
async function fit(target = page) { await target.getByRole("button", { name: "适应画布", exact: true }).click(); }
async function checkValid(target = page) {
  await target.waitForFunction(() => document.querySelector('[data-workflow-validation] strong')?.textContent.includes('检查通过'));
}
async function undo() { await page.getByRole("button", { name: "撤销上次编排操作" }).click(); }
async function dragNode(id, dx, dy) {
  await page.locator(".workflow-canvas").scrollIntoViewIfNeeded();
  const box = await node(id).boundingBox(); assert.ok(box);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 16 }); await page.mouse.up();
}
async function connect(from, to, drag = false, target = page) {
  if (!drag) { await port(from, "out", target).click(); await port(to, "in", target).click(); return; }
  const a = await port(from, "out", target).boundingBox(), b = await port(to, "in", target).boundingBox();
  await target.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await target.mouse.down();
  await target.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 }); await target.mouse.up();
}
async function deleteEdge(from, to) {
  await page.getByRole("button", { name: `连线：${from} → ${to}`, exact: true }).focus();
  await page.keyboard.press("Enter"); await page.keyboard.press("Delete");
}
async function save() {
  await page.getByRole("button", { name: "保存编排", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "流程已保存" }).waitFor();
}
try {
  assert.ok((await context.request.post(`${apiPath}/reset`)).ok());
   await openEditor(); await checkValid();
   assert.equal(await page.locator('[data-workflow-validation] strong').textContent(), "检查通过");
   assert.equal(await page.locator('[data-workflow-validation] small').count(), 0, "removed automatic-check description stays hidden");
   assert.equal(await page.locator('[data-workflow-toggle]').count(), 0, "required stages stay enabled");
  const originalIds = await ids();
  assert.equal(originalIds.length, 8);
  assert.ok(!originalIds.includes("apply_mcdr_template"));
  assert.equal(originalIds[2], "check_java_dependencies");
   assert.ok((await page.locator(".workflow-canvas-wrap").boundingBox()).height >= 900, "desktop canvas expands for the five default turns");
   assert.equal(await page.locator("[data-parallel-group]").count(), 2);
   assert.equal(await node("configure_python").locator('.workflow-node-number').textContent(), "06", "stage numbers stay stable when execution order changes");
  const promptBefore = await page.locator(".workflow-prompt-text").innerText();
  assert.ok(promptBefore.includes("check_java_environment(minecraftVersion=实际版本)"));
  assert.equal(await page.locator(".empty-workspace").count(), 0);
  const transformBefore = await node("configure_python").getAttribute("transform");
  await dragNode("configure_python", 100, -46);
  const transformMoved = await node("configure_python").getAttribute("transform");
  assert.notEqual(transformMoved, transformBefore);
  assert.deepEqual(await ids(), originalIds, "free dragging never reorders execution");
  await page.waitForFunction(() => !document.querySelector('.workflow-prompt-text')?.classList.contains('stale'));
  assert.equal(await page.locator(".workflow-prompt-text").innerText(), promptBefore);
  await undo(); assert.equal(await node("configure_python").getAttribute("transform"), transformBefore);
  await page.getByRole("button", { name: "重做编排操作" }).click();
  assert.equal(await node("configure_python").getAttribute("transform"), transformMoved);
  await node("configure_python").focus(); await page.keyboard.press("ArrowRight");
  assert.notEqual(await node("configure_python").getAttribute("transform"), transformMoved);
  await page.keyboard.press("Control+z"); assert.equal(await node("configure_python").getAttribute("transform"), transformMoved);
  await checkValid(); await fit();

  const cameraBefore = await page.locator(".workflow-canvas > g").getAttribute("transform");
  const rect = await page.locator(".workflow-canvas").boundingBox();
  await page.mouse.move(rect.x + rect.width - 22, rect.y + rect.height - 105); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 58, rect.y + rect.height - 145, { steps: 5 }); await page.mouse.up();
  assert.notEqual(await page.locator(".workflow-canvas > g").getAttribute("transform"), cameraBefore);
  await fit();
  const zoomBefore = await page.locator(".workflow-canvas-tools output").innerText();
  await page.getByRole("button", { name: "放大流程画布" }).click();
  assert.notEqual(await page.locator(".workflow-canvas-tools output").innerText(), zoomBefore);
  await fit();

  // Invalid edits stay visible; undo, line deletion and reconnect repair them.
  await connect("extract_to_workspace", "prepare_server_slot", true);
  assert.match(await page.locator("[data-workflow-validation]").innerText(), /闭环/);
   assert.equal(await page.locator("[data-workflow-edge]").count(), 10);
  assert.ok(await page.locator(".workflow-node.invalid").count());
  assert.ok(await page.getByRole("button", { name: "保存编排", exact: true }).isDisabled());
  await undo(); await checkValid();
   await deleteEdge("获取服务端包到槽位", "还原到 server 目录");
  assert.match(await page.locator("[data-workflow-validation]").innerText(), /入口|出口/);
   assert.equal(await page.locator("[data-workflow-edge]").count(), 8);
   await connect("prepare_server_slot", "extract_to_workspace", true); await checkValid();
   assert.equal(await page.locator("[data-workflow-edge]").count(), 9);
  // Two clicks and keyboard port activation are alternatives to dragging.
  await port("identify_modpack", "out").focus(); await page.keyboard.press("Enter");
  await port("identify_modpack", "in").focus(); await page.keyboard.press("Enter");
  assert.match(await page.locator("[data-workflow-validation]").innerText(), /自身/);
  await undo(); await checkValid();

   // Sparse cross-layer edges are legal; no hard-coded prerequisite has to stay wired.
   await connect("configure_python", "final_mcdr_test"); await checkValid();
   assert.equal(await page.locator("[data-parallel-group]").count(), 2);
  await page.waitForFunction(() => document.querySelector(".workflow-prompt-text")?.textContent.includes("→ 汇合（全部完成）"));
   await deleteEdge("还原到 server 目录", "最终验证");
   await connect("check_java_dependencies", "final_mcdr_test");
  await checkValid();
  assert.equal(await page.locator(".workflow-error").count(), 0, "a valid reconnection is not a rejected-operation error");
   await undo(); await undo(); await checkValid();

  await page.getByRole("button", { name: "添加步骤", exact: true }).click();
  assert.ok(await page.getByRole("button", { name: "保存编排", exact: true }).isDisabled());
  await page.getByLabel("步骤名称", { exact: true }).fill("部署后备份检查");
  await page.getByLabel("Agent 执行指令", { exact: true }).fill("用 list_server_files 检查配置；向用户汇报备份方案，不覆盖世界。");
  await checkValid();
  await page.waitForFunction(() => document.querySelector(".workflow-prompt-text")?.textContent.includes("部署后备份检查"));
  const customId = (await ids()).at(-2);
   const customToggle = page.locator(`[data-workflow-toggle="${customId}"]`);
   assert.equal(await customToggle.getAttribute("aria-label"), "部署后备份检查关闭步骤");
   await customToggle.click();
   assert.ok((await node(customId).getAttribute("class")).includes("inactive"), "custom card toggle disables the step");
    assert.equal(await page.locator('input[role="switch"]').isChecked(), false);
   await page.waitForFunction(() => !document.querySelector(".workflow-prompt-text")?.textContent.includes("部署后备份检查"));
   await customToggle.focus(); await page.keyboard.press("Enter");
   assert.equal(await page.locator(`[data-workflow-toggle="${customId}"]`).getAttribute("aria-label"), "部署后备份检查关闭步骤");
   await page.waitForFunction(() => document.querySelector(".workflow-prompt-text")?.textContent.includes("部署后备份检查"));
   await undo();
   assert.ok((await node(customId).getAttribute("class")).includes("inactive"), "undo restores the disabled state");
   await page.getByRole("button", { name: "重做编排操作" }).click();
   assert.ok(!(await node(customId).getAttribute("class")).includes("inactive"));
  await node(customId).focus(); await page.keyboard.press("ArrowRight");
  const customTransform = await node(customId).getAttribute("transform");
  await page.locator(".settings-nav-item").filter({ hasText: "技能管理" }).click();
  await page.locator(".settings-nav-item").filter({ hasText: "流程编排" }).click();
  assert.equal((await ids()).length, 9, "unsaved draft survives navigation");
  await page.route("**/api/settings/deployment-workflow", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟保存失败" }) });
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存编排", exact: true }).click();
  await page.locator(".workflow-error").filter({ hasText: "模拟保存失败" }).waitFor();
  assert.equal((await ids()).length, 9, "failed save retains the draft");
  await page.unroute("**/api/settings/deployment-workflow");
  await save();
  const saved = (await (await context.request.get(apiPath)).json()).workflow;
  assert.equal(saved.steps.at(-2).label, "部署后备份检查");
   assert.equal(saved.canvas.edges.length, 13);
  assert.equal(saved.steps.find(step => step.id === "configure_python").parallelGroup, saved.steps.find(step => step.id === "check_java_dependencies").parallelGroup);
  const badGraph = structuredClone(saved); badGraph.canvas.edges.push({ id: 'bad_api', from: 'final_mcdr_test', to: 'identify_modpack' });
  assert.equal((await context.request.put(apiPath, { data: badGraph })).status(), 400);
  assert.equal((await context.request.post(`${apiPath}/preview`, { data: { workflow: badGraph } })).status(), 400);
  assert.deepEqual((await (await context.request.get(apiPath)).json()).workflow, saved, "server rejection never mutates saved graph");
  await openEditor();
  assert.equal((await ids()).length, 9);
  assert.equal(await node(customId).getAttribute("transform"), customTransform);
   assert.equal(await page.locator("[data-parallel-group]").count(), 2);
  await page.getByRole("button", { name: "完整默认 System Prompt", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".workflow-prompt-text")?.textContent.includes("运行时工具事实"));
  await page.getByRole("button", { name: "流程提示词", exact: true }).click();
  await page.getByRole("button", { name: "自动整理", exact: true }).click();
  assert.notEqual(await node(customId).getAttribute("transform"), customTransform);
  await checkValid(); await save();
  await node("check_java_dependencies").click();
  await page.locator(".settings-content").evaluate((el) => { el.scrollTop = 0; });
  if (await page.getByRole("button", { name: "切换到暗色模式" }).count()) await page.getByRole("button", { name: "切换到暗色模式" }).click();
  await page.screenshot({ path: "/tmp/opencode/workflow-browser/freeform-desktop-dark.png" });
  await page.getByRole("button", { name: "切换到亮色模式" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light" && getComputedStyle(document.querySelector('.workflow-fields textarea')).backgroundColor === "rgb(255, 255, 255)");
  await page.screenshot({ path: "/tmp/opencode/workflow-browser/freeform-desktop-light.png" });

  for (const width of [820, 680, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 1100 }); await fit();
    await page.locator(".settings-content").evaluate((el) => { el.scrollTop = 0; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal overflow`);
    assert.ok((await page.locator(".workflow-canvas").boundingBox()).width > 200, `${width}: canvas stays usable`);
    assert.ok(await page.evaluate(() => { const r = document.querySelector('.workflow-canvas-wrap'); return r.scrollWidth <= r.clientWidth; }), `${width}: tools fit inside canvas`);
    if (width === 390) await page.screenshot({ path: "/tmp/opencode/workflow-browser/freeform-mobile-light.png" });
    console.log(`PASS workflow layout ${width}px`);
  }

  // Touch drag moves geometry only; tapping ports builds a line, pinch stays anchored.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 1100 }, isMobile: true, hasTouch: true });
  await mobile.addCookies([{ name: "mcsa_token", value: auth.token, url }]);
  const touchPage = await mobile.newPage(); touchPage.on("pageerror", (error) => errors.push(error.message));
  await openEditor(touchPage); await touchPage.locator('.workflow-canvas').scrollIntoViewIfNeeded();
  const touchBefore = await node("configure_python", touchPage).getAttribute("transform");
  const box = await node("configure_python", touchPage).boundingBox();
  const session = await mobile.newCDPSession(touchPage);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  for (let i = 1; i <= 10; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + i * 4, y: start.y - i * 3, id: 1 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notEqual(await node("configure_python", touchPage).getAttribute("transform"), touchBefore);
  await checkValid(touchPage);
  await port("extract_to_workspace", "out", touchPage).tap(); await port("prepare_server_slot", "in", touchPage).tap();
  assert.match(await touchPage.locator("[data-workflow-validation]").innerText(), /闭环/);
  await touchPage.getByRole("button", { name: "撤销上次编排操作" }).tap(); await checkValid(touchPage);
  await fit(touchPage); await touchPage.locator('.workflow-canvas').scrollIntoViewIfNeeded();
  const beforePinch = await touchPage.locator('.workflow-canvas-tools output').innerText();
  const canvasBox = await touchPage.locator('.workflow-canvas').boundingBox();
  const cy = canvasBox.y + canvasBox.height / 2, cx = canvasBox.x + canvasBox.width / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 65, y: cy, id: 1 }, { x: cx + 65, y: cy, id: 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notEqual(await touchPage.locator('.workflow-canvas-tools output').innerText(), beforePinch);
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log("PASS free drag, click/drag/keyboard/touch links, invalid draft retention, cycle/dependency validation, undo/redo, pan/zoom/pinch, custom steps, navigation, save failure/retry, graph/position persistence, manual fork/join, preview, themes");
} finally {
  // Restore only the disposable workspace configuration used by this test.
  await context.request.put(apiPath, { data: original.workflow });
  await browser.close();
}
