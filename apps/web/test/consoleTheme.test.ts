import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsoleLogs } from "../utils/consoleRendering";

function render(text: string) {
  return renderConsoleLogs([{ id: "theme-test", serverId: "theme-test-server", text, stream: "stdout", createdAt: "2026-09-30T00:00:00.000Z" }])[0]!.html;
}

test("ANSI white and Minecraft legacy colours support readable light-mode ink", () => {
  assert.match(render("\x1b[37mwhite"), /color: var\(--console-neutral, #e5e7eb\)/);
  assert.match(render("§fwhite §ayellow-green"), /var\(--console-green, #55ff55\)/);
});

test("explicit terminal backgrounds keep their original foreground/background pair", () => {
  const html = render("\x1b[37;40mwhite on black");
  assert.match(html, /color: #e5e7eb/);
  assert.match(html, /background-color: #0f172a/);
  assert.doesNotMatch(html, /var\(--console-neutral/);
});

test("plain text and HTML escaping are unaffected by appearance", () => {
  assert.equal(render("<log> & safe"), "&lt;log&gt; &amp; safe");
});
