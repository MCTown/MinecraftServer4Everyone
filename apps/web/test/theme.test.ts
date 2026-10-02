import assert from "node:assert/strict";
import { test } from "node:test";
import { oppositeTheme, resolveTheme } from "../utils/theme";

test("a first visit or an invalid preference always uses dark mode", () => {
  for (const value of [undefined, null, "", "system", "DARK", {}, 1]) {
    assert.equal(resolveTheme(value), "dark");
  }
});

test("valid saved preferences are retained", () => {
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("dark"), "dark");
});

test("the theme toggle switches in both directions", () => {
  assert.equal(oppositeTheme("dark"), "light");
  assert.equal(oppositeTheme("light"), "dark");
});
