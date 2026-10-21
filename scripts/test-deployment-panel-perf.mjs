// Browser-level reproduction using the production styles and console DOM shape.
// npm install --prefix /tmp/opencode/deployment-panel-perf playwright
// /tmp/opencode/deployment-panel-perf/node_modules/.bin/playwright install chromium
// PLAYWRIGHT_MODULE=/tmp/opencode/deployment-panel-perf/node_modules/playwright/index.mjs node scripts/test-deployment-panel-perf.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const paths = ["apps/web/assets/css/main.css", "apps/web/assets/css/layout/command-bridge.css"];
const styles = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const version of ["baseline", "fixed"]) {
    // Reintroduce the old height animation for the control group, so this
    // reproduction remains runnable after the fix is committed.
    const css = styles + (version === "baseline"
      ? ".deployment-progress-shell { transition: grid-template-rows 260ms cubic-bezier(0.22, 1, 0.36, 1); }"
      : "");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<style>${css}
      body { margin: 0; } .left-operation-stack { width: 650px; height: 850px; }
      .deployment-panel-body { height: 330px; }
    </style><div class="left-operation-stack">
      <section class="card stack workspace-card console-card single-console-panel">
        <header>终端</header><div class="console"></div><form>输入服务端控制台指令 <button>发送</button></form>
      </section>
      <div class="deployment-progress-shell is-collapsed">
        <button class="deployment-progress-toggle">部署</button>
        <section class="deployment-progress-card"><div class="deployment-panel-body">正在部署服务端</div></section>
      </div>
    </div>`);
    await page.evaluate(() => {
      const list = document.querySelector(".console");
      list.innerHTML = Array.from({ length: 2000 }, (_, i) =>
        `<div class="console-entry stdout"><span style="color: #22c55e">[12:00:00 INFO]</span> Preparing spawn area ${i}: Minecraft server log output\n</div>`).join("");
      list.scrollTop = list.scrollHeight;
      document.querySelector(".deployment-progress-toggle").onclick = () => {
        document.querySelector(".deployment-progress-shell").classList.toggle("is-collapsed");
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    // Throttle consistently to make the repeated large-layout cost visible.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const before = await metrics();
    const frameTimes = await page.evaluate(async () => {
      const frames = [];
      let previous = performance.now();
      let active = true;
      const frame = (now) => {
        frames.push(now - previous);
        previous = now;
        if (active) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      for (let i = 0; i < 6; i++) {
        document.querySelector(".deployment-progress-toggle").click();
        await new Promise((resolve) => setTimeout(resolve, 380));
      }
      active = false;
      return frames;
    });
    const after = await metrics();
    results.push({ version, layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000), layouts: after.LayoutCount - before.LayoutCount,
      slowFrames: frameTimes.filter((ms) => ms > 50).length });
    assert.equal(await page.locator(".console-entry").count(), 2000, "logs must not be dropped");
    if (version === "fixed") {
      for (const reducedMotion of ["no-preference", "reduce"]) {
        await page.emulateMedia({ reducedMotion });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.locator(".left-operation-stack").evaluate((element) => { element.style.width = "100%"; });
          // Exercise quick reversals as well as settled states.
          await page.evaluate(() => {
            const button = document.querySelector(".deployment-progress-toggle");
            button.click(); button.click(); button.click();
          });
          await page.waitForTimeout(300);
          assert.ok(await page.locator(".deployment-progress-card").evaluate((element) => element.getBoundingClientRect().height > 0));
          assert.ok(await page.evaluate(() => document.querySelector("form").getBoundingClientRect().bottom <= document.querySelector(".deployment-progress-shell").getBoundingClientRect().top + 1), "dock must not cover command input");
          await page.locator(".deployment-progress-toggle").click();
          await page.waitForTimeout(300);
          assert.equal(await page.locator(".deployment-progress-card").evaluate((element) => element.getBoundingClientRect().height), 0);
        }
      }
    }
    await page.close();
  }
  console.table(results);
  assert.ok(results[1].layoutMs < results[0].layoutMs * 0.5, "toggle layout cost should fall by at least 50%");
} finally {
  await browser.close();
}
