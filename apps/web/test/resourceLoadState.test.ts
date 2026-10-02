import assert from "node:assert/strict";
import { test } from "node:test";
import { useResourceLoadState } from "../composables/useResourceLoadState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("initial loading is not empty data; an empty successful response is loaded", async () => {
  const state = useResourceLoadState();
  assert.equal(state.initialLoading.value, true);
  assert.equal(state.loaded.value, false);
  await state.run(async () => [], () => undefined);
  assert.equal(state.loaded.value, true);
  assert.equal(state.initialLoading.value, false);
});

test("refresh retains loaded data and failures end loading without masquerading as empty", async () => {
  const state = useResourceLoadState();
  let data = ["existing"];
  await state.run(async () => data, (next) => { data = next; });
  const request = deferred<string[]>();
  const refresh = state.run(() => request.promise, (next) => { data = next; });
  assert.equal(state.loading.value, true);
  assert.equal(state.initialLoading.value, false);
  assert.deepEqual(data, ["existing"]);
  request.reject(new Error("offline"));
  await assert.rejects(refresh, /offline/);
  assert.equal(state.loading.value, false);
  assert.equal(state.loaded.value, true);
  assert.equal(state.error.value, "offline");
  assert.deepEqual(data, ["existing"]);
  await state.run(async () => ["fresh"], (next) => { data = next; });
  assert.equal(state.error.value, "");
  assert.deepEqual(data, ["fresh"]);
});

test("initial failure can retry and does not stay on a skeleton forever", async () => {
  const state = useResourceLoadState();
  await assert.rejects(state.run(async () => { throw new Error("offline"); }, () => undefined));
  assert.equal(state.initialLoading.value, false);
  assert.equal(state.loaded.value, false);
  assert.equal(state.error.value, "offline");
  await state.run(async () => [], () => undefined);
  assert.equal(state.loaded.value, true);
  assert.equal(state.error.value, "");
});

test("a stale response cannot overwrite newer data or finish a newer loading state", async () => {
  const state = useResourceLoadState();
  const old = deferred<string>();
  const latest = deferred<string>();
  let data = "";
  const first = state.run(() => old.promise, (next) => { data = next; });
  const second = state.run(() => latest.promise, (next) => { data = next; });
  old.resolve("old");
  await first;
  assert.equal(data, "");
  assert.equal(state.loading.value, true);
  latest.resolve("latest");
  await second;
  assert.equal(data, "latest");
});

test("context reset and live snapshots invalidate outstanding requests", async () => {
  const state = useResourceLoadState();
  const old = deferred<string>();
  let data = "";
  const first = state.run(() => old.promise, (next) => { data = next; });
  state.reset();
  old.resolve("wrong instance");
  await first;
  assert.equal(data, "");
  assert.equal(state.initialLoading.value, true);
  const rest = deferred<string>();
  const second = state.run(() => rest.promise, (next) => { data = next; });
  data = "live";
  state.acceptSnapshot();
  rest.reject(new Error("stale REST failure"));
  await second;
  assert.equal(data, "live");
  assert.equal(state.loaded.value, true);
  assert.equal(state.loading.value, false);
  assert.equal(state.error.value, "");
});
