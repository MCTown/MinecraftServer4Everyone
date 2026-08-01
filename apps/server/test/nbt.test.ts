import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  byteArray,
  compound,
  decompressChunk,
  isExternalChunk,
  list,
  longArray,
  numberValue,
  parseNbt,
  stringValue
} from "../src/services/nbt.js";
import {
  encodeNbt,
  nbtByte,
  nbtByteArray,
  nbtCompound,
  nbtDouble,
  nbtInt,
  nbtIntArray,
  nbtList,
  nbtLong,
  nbtLongArray,
  nbtShort,
  nbtString
} from "./helpers/nbt.js";

test("parseNbt round-trips every supported tag type", () => {
  const root = parseNbt(encodeNbt(nbtCompound({
    b: nbtByte(-7),
    s: nbtShort(-300),
    i: nbtInt(70_000),
    l: nbtLong(-9_007_199_254_740_993n),
    d: nbtDouble(0.5),
    text: nbtString("你好 world"),
    bytes: nbtByteArray(new Uint8Array([1, 2, 255])),
    ints: nbtIntArray([1, -2, 3]),
    longs: nbtLongArray([1n, -2n]),
    nested: nbtCompound({ inner: nbtInt(1) }),
    items: nbtList([nbtInt(4), nbtInt(5)])
  })));

  assert.equal(numberValue(root.b), -7);
  assert.equal(numberValue(root.s), -300);
  assert.equal(numberValue(root.i), 70_000);
  assert.equal(root.l, -9_007_199_254_740_993n);
  assert.equal(numberValue(root.d), 0.5);
  assert.equal(stringValue(root.text), "你好 world");
  assert.deepEqual([...byteArray(root.bytes)!], [1, 2, 255]);
  assert.deepEqual(root.ints, [1, -2, 3]);
  assert.deepEqual(longArray(root.longs), [1n, -2n]);
  assert.equal(numberValue(compound(root.nested)!.inner), 1);
  assert.deepEqual(list(root.items), [4, 5]);
});

test("parseNbt rejects a non-compound root", () => {
  assert.throws(() => parseNbt(Buffer.from([3, 0, 0, 0, 0, 0, 0])), /根标签不是 Compound/);
});

test("parseNbt rejects truncated payloads instead of returning partial data", () => {
  const encoded = encodeNbt(nbtCompound({ value: nbtLong(1n) }));
  assert.throws(() => parseNbt(encoded.subarray(0, encoded.length - 4)), /NBT 数据不完整/);
});

test("parseNbt rejects an unknown tag type", () => {
  // type 13 does not exist in the NBT spec.
  const payload = Buffer.concat([Buffer.from([10, 0, 0, 13, 0, 1, 0x78]), Buffer.from([0])]);
  assert.throws(() => parseNbt(payload), /NBT 标签类型无效/);
});

test("parseNbt refuses nesting deeper than the depth limit", () => {
  // 40 levels of compound exceeds maxDepth (32).
  let deep = nbtCompound({ leaf: nbtInt(1) });
  for (let level = 0; level < 40; level += 1) deep = nbtCompound({ child: deep });
  assert.throws(() => parseNbt(encodeNbt(deep)), /NBT 嵌套层级过深/);
});

test("parseNbt rejects a declared array length larger than the buffer", () => {
  // ByteArray claims 2_000_001 entries, one past maxArrayLength.
  const header = Buffer.from([10, 0, 0, 7, 0, 1, 0x61]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(2_000_001, 0);
  assert.throws(() => parseNbt(Buffer.concat([header, length])), /NBT 数组过大|NBT 数据不完整/);
});

test("parseNbt rejects an invalid list element type", () => {
  const header = Buffer.from([10, 0, 0, 9, 0, 1, 0x61, 99]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(1, 0);
  assert.throws(() => parseNbt(Buffer.concat([header, length])), /列表元素类型无效/);
});

test("parseNbt accepts an empty list with element type 0", () => {
  const root = parseNbt(encodeNbt(nbtCompound({ empty: nbtList([]) })));
  assert.deepEqual(list(root.empty), []);
});

test("decompressChunk handles gzip, zlib and uncompressed payloads", () => {
  const nbt = encodeNbt(nbtCompound({ ok: nbtInt(1) }));
  assert.equal(numberValue(parseNbt(decompressChunk(gzipSync(nbt), 1)).ok), 1);
  assert.equal(numberValue(parseNbt(decompressChunk(nbt, 3)).ok), 1);
});

test("decompressChunk refuses external chunk payloads and unknown schemes", () => {
  assert.equal(isExternalChunk(0x82), true);
  assert.equal(isExternalChunk(2), false);
  assert.throws(() => decompressChunk(Buffer.alloc(1), 0x82), /外部 .mcc/);
  assert.throws(() => decompressChunk(Buffer.alloc(1), 7), /不支持的区块压缩类型：7/);
});

test("accessor helpers narrow types without throwing on mismatches", () => {
  assert.equal(compound(42), null);
  assert.equal(compound(new Uint8Array([1])), null);
  assert.equal(compound(1n), null);
  assert.deepEqual(list("nope"), []);
  assert.equal(numberValue("nope"), null);
  assert.equal(numberValue(5n), 5);
  assert.equal(stringValue(5), null);
  assert.equal(byteArray([1, 2]), null);
  // A long array must be entirely bigint; a mixed array is rejected outright.
  assert.equal(longArray([1n, 2]), null);
});
