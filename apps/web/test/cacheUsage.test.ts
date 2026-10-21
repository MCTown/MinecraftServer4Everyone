import assert from "node:assert/strict";
import test from "node:test";
import { cacheRateLabel } from "../utils/cacheUsage";

test("cache tooltip distinguishes real zero, missing data and inconsistent gateway accounting", () => {
  assert.equal(cacheRateLabel({ status: "available", rate: 0.99356 }), "99.4%");
  assert.equal(cacheRateLabel({ status: "available", rate: 0 }), "0.0%");
  assert.equal(cacheRateLabel(undefined), "暂无数据");
  assert.equal(cacheRateLabel({ status: "unavailable" }), "暂无数据");
  assert.equal(cacheRateLabel({ status: "inconsistent" }), "统计口径异常");
  assert.equal(cacheRateLabel({ status: "available", rate: Infinity }), "暂无数据");
});
