import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeFileManagerPreferences } from "../utils/fileManagerPreferences.js";

test("finder display defaults are seeded once without replacing user preferences", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  initializeFileManagerPreferences("instance", storage);
  assert.deepEqual(JSON.parse(values.get("vuefinder_config_instance")!), { view: "list", showTreeView: true, showThumbnails: false });
  storage.setItem("vuefinder_config_instance", JSON.stringify({ view: "grid", showTreeView: false, pinnedFolders: ["files://plugins"] }));
  initializeFileManagerPreferences("instance", storage);
  assert.deepEqual(JSON.parse(values.get("vuefinder_config_instance")!), { view: "grid", showTreeView: false, showThumbnails: false, pinnedFolders: ["files://plugins"] });
  initializeFileManagerPreferences("mobile", storage, false);
  assert.equal(JSON.parse(values.get("vuefinder_config_mobile")!).showTreeView, false);
  assert.doesNotThrow(() => initializeFileManagerPreferences("restricted", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined }));
});
