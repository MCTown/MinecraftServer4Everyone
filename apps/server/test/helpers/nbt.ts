import { deflateSync } from "node:zlib";

/**
 * Minimal NBT writer used only by tests. It mirrors the subset of the format the
 * production reader in `src/services/nbt.ts` accepts, so fixtures stay readable
 * instead of being checked-in binary blobs.
 */
export type Tag =
  | { type: 1; value: number }
  | { type: 2; value: number }
  | { type: 3; value: number }
  | { type: 4; value: bigint }
  | { type: 5; value: number }
  | { type: 6; value: number }
  | { type: 7; value: Uint8Array }
  | { type: 8; value: string }
  | { type: 9; items: Tag[] }
  | { type: 10; entries: Record<string, Tag> }
  | { type: 11; values: number[] }
  | { type: 12; values: bigint[] };

export const nbtByte = (value: number): Tag => ({ type: 1, value });
export const nbtShort = (value: number): Tag => ({ type: 2, value });
export const nbtInt = (value: number): Tag => ({ type: 3, value });
export const nbtLong = (value: bigint): Tag => ({ type: 4, value });
export const nbtFloat = (value: number): Tag => ({ type: 5, value });
export const nbtDouble = (value: number): Tag => ({ type: 6, value });
export const nbtByteArray = (value: Uint8Array): Tag => ({ type: 7, value });
export const nbtString = (value: string): Tag => ({ type: 8, value });
export const nbtList = (items: Tag[]): Tag => ({ type: 9, items });
export const nbtCompound = (entries: Record<string, Tag>): Tag => ({ type: 10, entries });
export const nbtIntArray = (values: number[]): Tag => ({ type: 11, values });
export const nbtLongArray = (values: bigint[]): Tag => ({ type: 12, values });

function writeString(chunks: Buffer[], value: string) {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeInt16BE(encoded.length, 0);
  chunks.push(length, encoded);
}

function writePayload(chunks: Buffer[], tag: Tag) {
  switch (tag.type) {
    case 1: {
      const buffer = Buffer.alloc(1);
      buffer.writeInt8(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 2: {
      const buffer = Buffer.alloc(2);
      buffer.writeInt16BE(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 3: {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32BE(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 4: {
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64BE(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 5: {
      const buffer = Buffer.alloc(4);
      buffer.writeFloatBE(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 6: {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleBE(tag.value, 0);
      chunks.push(buffer);
      return;
    }
    case 7: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(tag.value.length, 0);
      chunks.push(length, Buffer.from(tag.value));
      return;
    }
    case 8: {
      writeString(chunks, tag.value);
      return;
    }
    case 9: {
      const itemType = tag.items[0]?.type ?? 0;
      const head = Buffer.alloc(5);
      head.writeUInt8(itemType, 0);
      head.writeInt32BE(tag.items.length, 1);
      chunks.push(head);
      for (const item of tag.items) writePayload(chunks, item);
      return;
    }
    case 10: {
      for (const [name, child] of Object.entries(tag.entries)) {
        chunks.push(Buffer.from([child.type]));
        writeString(chunks, name);
        writePayload(chunks, child);
      }
      chunks.push(Buffer.from([0]));
      return;
    }
    case 11: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(tag.values.length, 0);
      chunks.push(length);
      for (const value of tag.values) {
        const buffer = Buffer.alloc(4);
        buffer.writeInt32BE(value, 0);
        chunks.push(buffer);
      }
      return;
    }
    case 12: {
      const length = Buffer.alloc(4);
      length.writeInt32BE(tag.values.length, 0);
      chunks.push(length);
      for (const value of tag.values) {
        const buffer = Buffer.alloc(8);
        buffer.writeBigInt64BE(BigInt.asIntN(64, value), 0);
        chunks.push(buffer);
      }
      return;
    }
  }
}

/** Encodes a root compound with an empty name, matching how Minecraft stores chunks. */
export function encodeNbt(root: Tag, rootName = ""): Buffer {
  if (root.type !== 10) throw new Error("NBT root must be a compound");
  const chunks: Buffer[] = [Buffer.from([10])];
  writeString(chunks, rootName);
  writePayload(chunks, root);
  return Buffer.concat(chunks);
}

/**
 * Packs 4096 palette indices the way a modern (DataVersion >= 2529) chunk does:
 * each long holds `floor(64 / bits)` entries and never straddles a boundary.
 */
export function packNonSpanning(indices: number[], bits: number): bigint[] {
  const perLong = Math.floor(64 / bits);
  const words: bigint[] = new Array(Math.ceil(indices.length / perLong)).fill(0n);
  for (const [index, value] of indices.entries()) {
    const word = Math.floor(index / perLong);
    const shift = BigInt((index % perLong) * bits);
    words[word] = words[word]! | (BigInt(value) << shift);
  }
  return words;
}

/** Packs indices the legacy pre-1.16 way, where an entry may span two longs. */
export function packSpanning(indices: number[], bits: number): bigint[] {
  const total = Math.ceil((indices.length * bits) / 64);
  const words: bigint[] = new Array(total).fill(0n);
  for (const [index, value] of indices.entries()) {
    const bit = index * bits;
    const word = Math.floor(bit / 64);
    const shift = bit % 64;
    words[word] = BigInt.asUintN(64, words[word]! | (BigInt(value) << BigInt(shift)));
    if (shift + bits > 64) {
      words[word + 1] = BigInt.asUintN(64, words[word + 1]! | (BigInt(value) >> BigInt(64 - shift)));
    }
  }
  return words;
}

export const sectorSize = 4_096;
export const headerSize = sectorSize * 2;

export interface RegionChunkInput {
  localX: number;
  localZ: number;
  /** Uncompressed NBT bytes; deflated with zlib (compression id 2) unless `raw` is set. */
  nbt?: Buffer;
  raw?: Buffer;
  compression?: number;
  timestamp?: number;
  /** Overrides the computed header entry, for crafting corrupt allocations. */
  header?: { sectorOffset: number; sectorCount: number };
}

/**
 * Assembles a syntactically valid `.mca` file. Chunks are laid out sequentially from
 * sector 2; `header` overrides let a test describe an allocation the real file layout
 * would never produce (out of range, overlapping, zero-count).
 */
export function buildRegionFile(chunks: RegionChunkInput[]): Buffer {
  const header = Buffer.alloc(headerSize);
  const body: Buffer[] = [];
  let nextSector = 2;

  for (const chunk of chunks) {
    const index = chunk.localZ * 32 + chunk.localX;
    const entryOffset = index * 4;
    const payload = chunk.raw ?? deflateSync(chunk.nbt ?? Buffer.alloc(0));
    const compression = chunk.compression ?? (chunk.raw ? 3 : 2);

    const record = Buffer.alloc(5 + payload.length);
    record.writeUInt32BE(payload.length + 1, 0);
    record.writeUInt8(compression, 4);
    payload.copy(record, 5);
    const sectorCount = Math.max(1, Math.ceil(record.length / sectorSize));
    const padded = Buffer.alloc(sectorCount * sectorSize);
    record.copy(padded, 0);

    const entry = chunk.header ?? { sectorOffset: nextSector, sectorCount };
    header.writeUIntBE(entry.sectorOffset, entryOffset, 3);
    header.writeUInt8(entry.sectorCount, entryOffset + 3);
    header.writeUInt32BE(chunk.timestamp ?? 1_700_000_000, sectorSize + entryOffset);

    body.push(padded);
    nextSector += sectorCount;
  }

  return Buffer.concat([header, ...body]);
}

/** A 16x16x16 section whose single-entry palette means `data` is legitimately absent. */
export function uniformSection(y: number, block: string) {
  return nbtCompound({
    Y: nbtByte(y),
    block_states: nbtCompound({ palette: nbtList([nbtCompound({ Name: nbtString(block) })]) })
  });
}
