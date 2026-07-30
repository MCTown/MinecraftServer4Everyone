import type { MapChunkPreview, MapChunkPreviewCell } from "../types.js";
import { compound, list, longArray, numberValue, stringValue, type NbtValue } from "./nbt.js";

export const sectorSize = 4_096;
export const headerSize = sectorSize * 2;
export const regionFilePattern = /^r\.(-?(?:0|[1-9]\d{0,8}))\.(-?(?:0|[1-9]\d{0,8}))\.mca$/i;
export const externalChunkFilePattern = /^c\.(-?(?:0|[1-9]\d{0,9}))\.(-?(?:0|[1-9]\d{0,9}))\.mcc$/i;

/** DataVersion 2529 (20w17a) switched block state longs to a non-spanning layout. */
const nonSpanningDataVersion = 2529;
const airBlocks = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

export function externalChunkFileName(chunkX: number, chunkZ: number) {
  return `c.${chunkX}.${chunkZ}.mcc`;
}

function colorForBlock(block: string) {
  if (block.includes("water") || block.includes("ice")) return "#4f9fc2";
  if (block.includes("lava")) return "#d86f28";
  if (block.includes("grass") || block.includes("leaves") || block.includes("moss")) return "#6f9b59";
  if (block.includes("sand") || block.includes("terracotta")) return "#b89b68";
  if (block.includes("stone") || block.includes("deepslate") || block.includes("ore")) return "#747b7d";
  if (block.includes("snow") || block.includes("quartz")) return "#c6d0d0";
  if (block.includes("wood") || block.includes("log") || block.includes("planks")) return "#946f4f";
  return "#8d8c7e";
}

function nbtCompound(value: unknown) {
  return compound(value as NbtValue | undefined);
}

function nbtList(value: unknown) {
  return list(value as NbtValue | undefined);
}

function nbtNumber(value: unknown) {
  return numberValue(value as NbtValue | undefined);
}

function nbtString(value: unknown) {
  return stringValue(value as NbtValue | undefined);
}

function paletteName(value: unknown) {
  const entry = nbtCompound(value);
  return entry ? nbtString(entry.Name) ?? "minecraft:air" : "minecraft:air";
}

interface DecodedSection {
  y: number;
  palette: string[];
  values: bigint[];
  bits: number;
  spanning: boolean;
  entriesPerLong: number;
}

function paletteBits(paletteLength: number) {
  return Math.max(4, Math.ceil(Math.log2(paletteLength)));
}

function expectedWordCount(bits: number, spanning: boolean) {
  if (spanning) return Math.ceil((4_096 * bits) / 64);
  return Math.ceil(4_096 / Math.floor(64 / bits));
}

/**
 * Reads one 4096-entry block state index. Pre-1.16 chunks pack entries across
 * long boundaries; 1.16+ chunks pad each long and never straddle.
 */
function unpackState(section: DecodedSection, index: number) {
  const mask = (1n << BigInt(section.bits)) - 1n;
  if (!section.spanning) {
    const word = Math.floor(index / section.entriesPerLong);
    const shift = (index % section.entriesPerLong) * section.bits;
    const value = BigInt.asUintN(64, section.values[word]!) >> BigInt(shift);
    return Number(value & mask);
  }
  const bit = index * section.bits;
  const word = Math.floor(bit / 64);
  const shift = bit % 64;
  let value = BigInt.asUintN(64, section.values[word]!) >> BigInt(shift);
  if (shift + section.bits > 64) {
    value |= BigInt.asUintN(64, section.values[word + 1]!) << BigInt(64 - shift);
  }
  return Number(value & mask);
}

function decodeSectionBlocks(section: Record<string, unknown>, dataVersion: number | null): DecodedSection | null {
  const y = nbtNumber(section.Y);
  if (y === null || !Number.isInteger(y) || y < -128 || y > 127) return null;

  const modern = nbtCompound(section.block_states);
  const palette = modern ? nbtList(modern.palette) : nbtList(section.Palette);
  if (palette.length === 0) return null;
  const values = longArray((modern ? modern.data : section.BlockStates) as NbtValue | undefined) ?? [];
  const bits = paletteBits(palette.length);

  // A single-entry palette legitimately omits `data`: the whole section is that block.
  if (values.length === 0) {
    return palette.length === 1
      ? { y, palette: palette.map(paletteName), values: [], bits, spanning: false, entriesPerLong: Math.floor(64 / bits) }
      : null;
  }

  const spanning = modern ? (dataVersion ?? 0) < nonSpanningDataVersion : true;
  if (values.length !== expectedWordCount(bits, spanning)) return null;
  return { y, palette: palette.map(paletteName), values, bits, spanning, entriesPerLong: Math.floor(64 / bits) };
}

function sectionBlockAt(section: DecodedSection, index: number) {
  if (section.values.length === 0) return section.palette[0] ?? "minecraft:air";
  return section.palette[unpackState(section, index)] ?? "minecraft:air";
}

export function previewFromNbt(
  root: Record<string, unknown>,
  regionX: number,
  regionZ: number,
  localX: number,
  localZ: number,
  filePath: string
): MapChunkPreview {
  const level = nbtCompound(root.Level) ?? root;
  const dataVersion = nbtNumber(root.DataVersion ?? level.DataVersion);
  const sections = nbtList(level.sections ?? level.Sections)
    .flatMap((value) => {
      const section = nbtCompound(value);
      const decoded = section ? decodeSectionBlocks(section, dataVersion) : null;
      return decoded ? [decoded] : [];
    })
    .sort((a, b) => b.y - a.y);

  const cells: MapChunkPreviewCell[] = [];
  for (let z = 0; z < 16; z += 1) {
    for (let x = 0; x < 16; x += 1) {
      let height = 0;
      let topBlock = "minecraft:air";
      for (const section of sections) {
        let found = false;
        for (let y = 15; y >= 0; y -= 1) {
          const block = sectionBlockAt(section, y * 256 + z * 16 + x);
          if (!airBlocks.has(block)) {
            height = section.y * 16 + y + 1;
            topBlock = block;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      cells.push({ localX: x, localZ: z, height, block: topBlock, color: colorForBlock(topBlock) });
    }
  }

  return {
    path: filePath,
    regionX,
    regionZ,
    localX,
    localZ,
    chunkX: regionX * 32 + localX,
    chunkZ: regionZ * 32 + localZ,
    dataVersion,
    cells,
    unsupportedReason: sections.length === 0 ? "该区块没有可解码的方块区段数据" : null
  };
}
