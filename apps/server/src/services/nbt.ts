import { gunzipSync, inflateSync } from "node:zlib";

export interface NbtCompound { [key: string]: NbtValue; }
export type NbtValue = null | number | bigint | string | Uint8Array | NbtValue[] | NbtCompound;

const maxDepth = 32;
const maxArrayLength = 2_000_000;
const maxStringLength = 65_535;
const maxDecompressedBytes = 24 * 1024 * 1024;
const maxNodeBudget = 4_000_000;
const externalChunkFlag = 0x80;

class NbtReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  private require(length: number) {
    if (length < 0 || this.offset + length > this.data.length) throw new Error("NBT 数据不完整");
  }

  byte() {
    this.require(1);
    return this.data[this.offset++]!;
  }

  int8() {
    this.require(1);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 1).getInt8(0);
    this.offset += 1;
    return value;
  }

  int16() {
    this.require(2);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2).getInt16(0);
    this.offset += 2;
    return value;
  }

  int32() {
    this.require(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getInt32(0);
    this.offset += 4;
    return value;
  }

  uint32() {
    this.require(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getUint32(0);
    this.offset += 4;
    return value;
  }

  int64() {
    this.require(8);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8).getBigInt64(0);
    this.offset += 8;
    return value;
  }

  float32() {
    this.require(4);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getFloat32(0);
    this.offset += 4;
    return value;
  }

  float64() {
    this.require(8);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8).getFloat64(0);
    this.offset += 8;
    return value;
  }

  string() {
    const length = this.int16();
    if (length > maxStringLength) throw new Error("NBT 字符串过长");
    this.require(length);
    const value = new TextDecoder("utf-8", { fatal: false }).decode(this.data.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  bytes(length: number) {
    if (length < 0 || length > maxArrayLength) throw new Error("NBT 数组过大");
    this.require(length);
    const value = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

interface NbtBudget { remaining: number; }

function spend(budget: NbtBudget, nodes: number) {
  budget.remaining -= nodes;
  if (budget.remaining < 0) throw new Error("NBT 结构超出解析预算");
}

function readPayload(reader: NbtReader, type: number, depth: number, budget: NbtBudget): NbtValue {
  if (depth > maxDepth) throw new Error("NBT 嵌套层级过深");
  spend(budget, 1);
  switch (type) {
    case 1: return reader.int8();
    case 2: return reader.int16();
    case 3: return reader.int32();
    case 4: return reader.int64();
    case 5: return reader.float32();
    case 6: return reader.float64();
    case 7: {
      const length = reader.int32();
      spend(budget, length);
      return reader.bytes(length);
    }
    case 8: return reader.string();
    case 9: {
      const itemType = reader.byte();
      const length = reader.int32();
      if (length < 0 || length > maxArrayLength) throw new Error("NBT 列表过大");
      if (length > 0 && (itemType < 1 || itemType > 12)) throw new Error("NBT 列表元素类型无效");
      spend(budget, length);
      const values: NbtValue[] = [];
      for (let index = 0; index < length; index += 1) values.push(readPayload(reader, itemType, depth + 1, budget));
      return values;
    }
    case 10: {
      const compound: NbtCompound = {};
      while (true) {
        const childType = reader.byte();
        if (childType === 0) return compound;
        if (childType < 1 || childType > 12) throw new Error("NBT 标签类型无效");
        const name = reader.string();
        compound[name] = readPayload(reader, childType, depth + 1, budget);
      }
    }
    case 11: {
      const length = reader.int32();
      if (length < 0 || length > maxArrayLength) throw new Error("NBT IntArray 过大");
      spend(budget, length);
      return Array.from({ length }, () => reader.int32());
    }
    case 12: {
      const length = reader.int32();
      if (length < 0 || length > maxArrayLength) throw new Error("NBT LongArray 过大");
      spend(budget, length);
      return Array.from({ length }, () => reader.int64());
    }
    default: throw new Error("NBT 标签类型无效");
  }
}

export function parseNbt(data: Uint8Array): NbtCompound {
  const reader = new NbtReader(data);
  if (reader.byte() !== 10) throw new Error("区块 NBT 根标签不是 Compound");
  reader.string();
  return readPayload(reader, 10, 0, { remaining: maxNodeBudget }) as NbtCompound;
}

export function decompressChunk(data: Uint8Array, compression: number) {
  if ((compression & externalChunkFlag) !== 0) {
    throw new Error("该区块数据存放在外部 .mcc 文件中，暂不支持预览");
  }
  const options = { maxOutputLength: maxDecompressedBytes };
  if (compression === 1) return gunzipSync(data, options);
  if (compression === 2) return inflateSync(data, options);
  if (compression === 3) {
    if (data.length > maxDecompressedBytes) throw new Error("区块数据超出解析上限");
    return Buffer.from(data);
  }
  throw new Error(`不支持的区块压缩类型：${compression}`);
}

export function isExternalChunk(compression: number) {
  return (compression & externalChunkFlag) !== 0;
}

export function compound(value: NbtValue | undefined): NbtCompound | null {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && typeof value !== "bigint"
    ? value as NbtCompound
    : null;
}

export function list(value: NbtValue | undefined): NbtValue[] {
  return Array.isArray(value) ? value : [];
}

export function numberValue(value: NbtValue | undefined) {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
}

export function stringValue(value: NbtValue | undefined) {
  return typeof value === "string" ? value : null;
}

export function byteArray(value: NbtValue | undefined) {
  return value instanceof Uint8Array ? value : null;
}

export function longArray(value: NbtValue | undefined) {
  return Array.isArray(value) && value.every((item) => typeof item === "bigint") ? value as bigint[] : null;
}
