import type { MapChunkPreview, MapChunkPreviewCell } from "../types.js";
import { compound, list, longArray, numberValue, stringValue, type NbtValue } from "./nbt.js";

export const sectorSize = 4_096;
export const headerSize = sectorSize * 2;
export const regionFilePattern = /^r\.(-?(?:0|[1-9]\d{0,8}))\.(-?(?:0|[1-9]\d{0,8}))\.mca$/i;
export const externalChunkFilePattern = /^c\.(-?(?:0|[1-9]\d{0,9}))\.(-?(?:0|[1-9]\d{0,9}))\.mcc$/i;

/** DataVersion 2529 (20w17a) switched block state longs to a non-spanning layout. */
const nonSpanningDataVersion = 2529;
const airBlocks = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const translucentBlock = /water|kelp|seagrass|bubble_column|lava|glass|ice|tinted_glass/;
/** Stop probing for the surface's underlying block after this many translucent layers. */
const translucentDepthCap = 12;

export function externalChunkFileName(chunkX: number, chunkZ: number) {
  return `c.${chunkX}.${chunkZ}.mcc`;
}

/**
 * Top-face colors approximating the resource-pack texture averages BlueMap reads.
 * Order matters: the first matching rule wins.
 */
const blockShades: Array<{ test: RegExp; color: string }> = [
  { test: /water|kelp|seagrass|bubble_column/, color: "#4a7fc0" },
  { test: /lava/, color: "#d8682a" },
  { test: /grass/, color: "#6fbf4e" },
  { test: /leaves|moss/, color: "#4e8f3c" },
  { test: /sand/, color: "#dcc78d" },
  { test: /snow/, color: "#e8eef4" },
  { test: /ice/, color: "#a8d8e8" },
  { test: /deepslate/, color: "#5d6064" },
  { test: /stone|ore|coal|copper|iron|gold|diamond|emerald|lapis|redstone|quartz|andesite|granite|diorite|tuff|basalt|cobblestone|bricks|netherite/, color: "#8a8d90" },
  { test: /terracotta/, color: "#b06a52" },
  { test: /clay/, color: "#a6a7c9" },
  { test: /gravel/, color: "#8f8a87" },
  { test: /planks|slab|stairs|fence|gate|door|trapdoor/, color: "#b3945e" },
  { test: /log|wood|bark|stem|wart/, color: "#9c7c52" },
  { test: /dirt|podzol|mycelium|farmland|path/, color: "#8a6b4e" },
  { test: /bedrock/, color: "#5c5c5c" },
  { test: /cactus/, color: "#5f9e3a" },
  { test: /netherrack|crimson|warped/, color: "#8c3f3a" },
  { test: /glass/, color: "#cfe6e8" },
  { test: /wool/, color: "#d8d2c6" }
];

function colorForBlock(block: string) {
  for (const shade of blockShades) {
    if (shade.test.test(block)) return shade.color;
  }
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
  /** 2048-byte nibble arrays (tag 7) with the light of every block in the section. */
  sky: Uint8Array | null;
  block: Uint8Array | null;
}

function byteArray(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.length > 0 ? value : null;
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
      ? { y, palette: palette.map(paletteName), values: [], bits, spanning: false, entriesPerLong: Math.floor(64 / bits), sky: byteArray(section.SkyLight), block: byteArray(section.BlockLight) }
      : null;
  }

  const spanning = modern ? (dataVersion ?? 0) < nonSpanningDataVersion : true;
  if (values.length !== expectedWordCount(bits, spanning)) return null;
  return { y, palette: palette.map(paletteName), values, bits, spanning, entriesPerLong: Math.floor(64 / bits), sky: byteArray(section.SkyLight), block: byteArray(section.BlockLight) };
}

function sectionBlockAt(section: DecodedSection, index: number) {
  if (section.values.length === 0) return section.palette[0] ?? "minecraft:air";
  return section.palette[unpackState(section, index)] ?? "minecraft:air";
}

/** Combined sky/block light (0-15) at one block position; 15 when the world stores no light. */
function lightAt(x: number, y: number, z: number, sections: DecodedSection[]) {
  const section = sections.find((candidate) => y >= candidate.y * 16 && y <= candidate.y * 16 + 15);
  if (!section) return 15;
  const index = (y & 15) << 8 | (z & 15) << 4 | (x & 15);
  const half = index >> 1;
  const high = (index & 1) === 1;
  const nibble = (data: Uint8Array) => data.length > half ? ((data[half]! >> (high ? 4 : 0)) & 0xf) : null;
  const sky = section.sky ? nibble(section.sky) : null;
  const block = section.block ? nibble(section.block) : null;
  if (sky === null && block === null) return 15;
  return Math.max(sky ?? 0, block ?? 0);
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
      let surfaceBlock = "minecraft:air";
      let surfaceY = 0;
      let surfaceColor = "#8d8c7e";
      let belowColor: string | null = null;
      let belowBlock: string | null = null;
      let belowY: number | null = null;
      let water = 0;
      let topFound = false;

      column: for (const section of sections) {
        for (let y = 15; y >= 0; y -= 1) {
          const block = sectionBlockAt(section, y * 256 + z * 16 + x);
          if (airBlocks.has(block)) continue;
          if (translucentBlock.test(block)) {
            if (!topFound) { surfaceBlock = block; surfaceColor = colorForBlock(block); surfaceY = section.y * 16 + y; topFound = true; }
            water += 1;
            if (water >= translucentDepthCap) break column;
            continue;
          }
          if (!topFound) {
            surfaceBlock = block; surfaceColor = colorForBlock(block); surfaceY = section.y * 16 + y; topFound = true;
            continue;
          }
          if (water > 0 && belowColor === null) { belowColor = colorForBlock(block); belowBlock = block; belowY = section.y * 16 + y; }
          break column;
        }
      }

      const surfaceLight = topFound ? lightAt(x, surfaceY + 1, z, sections) : 15;
      const belowLight = !topFound || belowY === null ? surfaceLight : lightAt(x, belowY + 1, z, sections);
      cells.push({
        localX: x,
        localZ: z,
        height: topFound ? surfaceY + 1 : 0,
        block: surfaceBlock,
        color: surfaceColor,
        below: belowColor,
        belowBlock,
        water,
        light: surfaceLight,
        belowLight
      });
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
