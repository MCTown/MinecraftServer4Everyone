import assert from "node:assert/strict";
import test from "node:test";
import { defaultPythonPackageIndexUrl } from "../src/config.js";
import { normalizePackageIndexUrl } from "../src/agent/tools/pythonRuntimeTool.js";

test("normalizePackageIndexUrl falls back to domestic default", () => {
  assert.equal(normalizePackageIndexUrl(""), defaultPythonPackageIndexUrl);
  assert.equal(normalizePackageIndexUrl("   "), defaultPythonPackageIndexUrl);
});

test("normalizePackageIndexUrl accepts http and https mirrors", () => {
  assert.equal(
    normalizePackageIndexUrl("https://mirrors.aliyun.com/pypi/simple"),
    "https://mirrors.aliyun.com/pypi/simple"
  );
  assert.equal(
    normalizePackageIndexUrl("http://mirrors.aliyun.com/pypi/simple/"),
    "http://mirrors.aliyun.com/pypi/simple/"
  );
});

test("normalizePackageIndexUrl rejects non-http schemes", () => {
  assert.throws(() => normalizePackageIndexUrl("ftp://example.com/simple"), /仅支持 HTTP 或 HTTPS/);
  assert.throws(() => normalizePackageIndexUrl("not a url"), /Invalid URL|URL/);
});
