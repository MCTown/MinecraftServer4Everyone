// Browser regression test using the stylesheet order from nuxt.config.ts.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-sidebar-layout.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const config = await readFile("apps/web/nuxt.config.ts", "utf8");
const paths = [...config.matchAll(/"~\/(assets\/css\/[^\"]+)"/g)].map((match) => `apps/web/${match[1]}`);
const css = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const width of [1440, 1180, 1024, 821, 820, 560, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    // Mobile capacity can reduce the actions to the four permanent controls.
    const count = width <= 820 ? 4 : 9;
    const button = '<button class="rail-button" type="button">图标</button>';
    await page.setContent(`<style>${css}</style><div class="app-shell">
      <aside class="sidebar command-rail">
        <div class="sidebar-head"><div class="brand-mark">MC</div></div>
        <nav class="rail-actions">${button.repeat(count)}</nav>
        <div class="rail-spacer"></div>
        <div class="rail-footer">${button}<span class="rail-count">5</span>${button}</div>
      </aside><main class="main">工作区</main></div>`);
    const layout = await page.evaluate(() => {
      const rail = document.querySelector(".command-rail");
      const actions = document.querySelector(".rail-actions");
      const footer = document.querySelector(".rail-footer").getBoundingClientRect();
      const head = document.querySelector(".sidebar-head").getBoundingClientRect();
      const nav = actions.getBoundingClientRect();
      const buttons = [...rail.querySelectorAll("button")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      return {
        height: rail.getBoundingClientRect().height,
        pageWidth: document.documentElement.scrollWidth,
        navStart: nav.x, navEnd: nav.right, headEnd: head.right, footerStart: footer.x,
        footerTop: footer.top, navBottom: nav.bottom, buttons,
        scrollable: actions.scrollWidth > actions.clientWidth,
        overflowX: getComputedStyle(actions).overflowX
      };
    });
    assert.ok(layout.buttons.every((rect) => rect.width >= 38 && rect.height >= 38), `${width}: buttons must not shrink`);
    if (width > 820) {
      assert.equal(layout.height, 900, `${width}: sidebar must span the viewport, not the legacy 15rem limit`);
      assert.ok(layout.navBottom <= layout.footerTop, `${width}: actions must not overlap footer`);
      const actions = layout.buttons.slice(0, count);
      assert.ok(actions.every((rect, index) => index === 0 || rect.y >= actions[index - 1].bottom + 1), `${width}: icons must not overlap`);
    } else {
      assert.equal(layout.height, 60, `${width}: mobile rail height`);
      assert.ok(layout.navStart >= layout.headEnd && layout.navEnd <= layout.footerStart, `${width}: navigation must stay between logo and footer`);
      assert.ok(layout.pageWidth <= width, `${width}: no page overflow`);
      if (layout.scrollable) assert.equal(layout.overflowX, "auto", `${width}: overflowing actions must remain scrollable`);
    }
    console.log(`PASS sidebar layout at ${width}px`);
  }
} finally {
  await browser.close();
}
