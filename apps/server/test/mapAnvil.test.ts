import assert from "node:assert/strict";
import { test } from "node:test";
import {
  externalChunkFileName,
  externalChunkFilePattern,
  headerSize,
  previewFromNbt,
  regionFilePattern,
  sectorSize
} from "../src/services/mapAnvil.js";
import type { NbtCompound } from "../src/services/nbt.js";
import { parseNbt } from "../src/services/nbt.js";
import {
  encodeNbt,
  nbtByte,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtLongArray,
  nbtString,
  packNonSpanning,
  packSpanning,
  uniformSection
} from "./helpers/nbt.js";

const air = "minecraft:air";

/** Round-trips through the real reader so tests exercise the same value shapes production sees. */
function root(entries: Parameters<typeof nbtCompound>[0]): NbtCompound {
  return parseNbt(encodeNbt(nbtCompound(entries)));
}

function cellAt(preview: ReturnType<typeof previewFromNbt>, x: number, z: number) {
  return preview.cells.find((cell) => cell.localX === x && cell.localZ === z)!;
}

/** Index inside a 4096-entry section, matching the y*256 + z*16 + x layout Minecraft uses. */
function sectionIndex(x: number, y: number, z: number) {
  return y * 256 + z * 16 + x;
}

test("constants match the Anvil format", () => {
  assert.equal(sectorSize, 4_096);
  assert.equal(headerSize, 8_192);
});

test("regionFilePattern accepts real names and rejects malformed ones", () => {
  assert.deepEqual(regionFilePattern.exec("r.0.0.mca")?.slice(1, 3), ["0", "0"]);
  assert.deepEqual(regionFilePattern.exec("r.-3.12.mca")?.slice(1, 3), ["-3", "12"]);
  assert.ok(regionFilePattern.test("R.1.1.MCA"));
  for (const name of ["r.01.0.mca", "r.0.mca", "r.0.0.mcb", "r..0.mca", "r.0.0.mca.bak", "r.+1.0.mca", "r.1234567890.0.mca"]) {
    assert.equal(regionFilePattern.test(name), false, name);
  }
});

test("externalChunkFilePattern round-trips the generated sidecar name", () => {
  const name = externalChunkFileName(-33, 64);
  assert.equal(name, "c.-33.64.mcc");
  assert.deepEqual(externalChunkFilePattern.exec(name)?.slice(1, 3), ["-33", "64"]);
  assert.equal(externalChunkFilePattern.test("c.0.mcc"), false);
  assert.equal(externalChunkFilePattern.test("c.00.0.mcc"), false);
});

test("previewFromNbt derives absolute chunk coordinates from region and local coordinates", () => {
  const preview = previewFromNbt(root({ sections: nbtList([uniformSection(0, "minecraft:stone")]) }), -2, 3, 5, 7, "world/region/r.-2.3.mca");
  assert.equal(preview.chunkX, -2 * 32 + 5);
  assert.equal(preview.chunkZ, 3 * 32 + 7);
  assert.equal(preview.path, "world/region/r.-2.3.mca");
  assert.equal(preview.cells.length, 256);
  assert.equal(preview.unsupportedReason, null);
});

test("previewFromNbt treats a single-entry palette with no data as a solid section", () => {
  const preview = previewFromNbt(root({ sections: nbtList([uniformSection(1, "minecraft:stone")]) }), 0, 0, 0, 0, "r.0.0.mca");
  const cell = cellAt(preview, 3, 4);
  // Section Y=1 is blocks 16..31, and the topmost non-air block is y=31, so height is 32.
  assert.equal(cell.height, 32);
  assert.equal(cell.block, "minecraft:stone");
  assert.equal(cell.color, "#747b7d");
});

test("previewFromNbt reports an all-air chunk as height zero without marking it unsupported", () => {
  const preview = previewFromNbt(root({ sections: nbtList([uniformSection(0, air)]) }), 0, 0, 0, 0, "r.0.0.mca");
  const cell = cellAt(preview, 0, 0);
  assert.equal(cell.height, 0);
  assert.equal(cell.block, air);
  assert.equal(preview.unsupportedReason, null);
});

test("previewFromNbt decodes non-spanning block states for DataVersion >= 2529", () => {
  // Palette of 2 => 4 bits/entry (the format's minimum), 16 entries per long.
  const indices = new Array(4_096).fill(0);
  indices[sectionIndex(2, 5, 6)] = 1;
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(3_465),
    sections: nbtList([nbtCompound({
      Y: nbtByte(0),
      block_states: nbtCompound({
        palette: nbtList([nbtCompound({ Name: nbtString(air) }), nbtCompound({ Name: nbtString("minecraft:grass_block") })]),
        data: nbtLongArray(packNonSpanning(indices, 4))
      })
    })])
  }), 0, 0, 0, 0, "r.0.0.mca");

  const cell = cellAt(preview, 2, 6);
  assert.equal(cell.block, "minecraft:grass_block");
  assert.equal(cell.height, 6);
  assert.equal(cell.color, "#6f9b59");
  // Every other column is air.
  assert.equal(cellAt(preview, 3, 6).height, 0);
});

test("previewFromNbt decodes legacy spanning block states below DataVersion 2529", () => {
  // 33 palette entries => 6 bits/entry, which straddles long boundaries.
  const palette = [air, ...Array.from({ length: 32 }, (_, index) => `minecraft:block_${index}`)];
  const indices = new Array(4_096).fill(0);
  indices[sectionIndex(9, 2, 11)] = 32;
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(2_230),
    sections: nbtList([nbtCompound({
      Y: nbtByte(0),
      block_states: nbtCompound({
        palette: nbtList(palette.map((name) => nbtCompound({ Name: nbtString(name) }))),
        data: nbtLongArray(packSpanning(indices, 6))
      })
    })])
  }), 0, 0, 0, 0, "r.0.0.mca");

  const cell = cellAt(preview, 9, 11);
  assert.equal(cell.block, "minecraft:block_31");
  assert.equal(cell.height, 3);
});

test("previewFromNbt decodes the pre-flattening Level/Palette/BlockStates layout", () => {
  const indices = new Array(4_096).fill(0);
  indices[sectionIndex(1, 0, 1)] = 1;
  const preview = previewFromNbt(root({
    Level: nbtCompound({
      Sections: nbtList([nbtCompound({
        Y: nbtByte(0),
        Palette: nbtList([nbtCompound({ Name: nbtString(air) }), nbtCompound({ Name: nbtString("minecraft:water") })]),
        BlockStates: nbtLongArray(packSpanning(indices, 4))
      })])
    })
  }), 0, 0, 0, 0, "r.0.0.mca");

  const cell = cellAt(preview, 1, 1);
  assert.equal(cell.block, "minecraft:water");
  assert.equal(cell.color, "#4f9fc2");
});

test("previewFromNbt picks the highest non-air block across stacked sections", () => {
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(3_465),
    sections: nbtList([
      uniformSection(0, "minecraft:stone"),
      uniformSection(2, "minecraft:sand"),
      uniformSection(4, air)
    ])
  }), 0, 0, 0, 0, "r.0.0.mca");

  const cell = cellAt(preview, 8, 8);
  // Section 4 is fully air, so the scan falls through to section 2 (blocks 32..47).
  assert.equal(cell.height, 48);
  assert.equal(cell.block, "minecraft:sand");
});

test("previewFromNbt handles negative section Y from 1.18 world height", () => {
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(3_465),
    sections: nbtList([uniformSection(-4, "minecraft:deepslate")])
  }), 0, 0, 0, 0, "r.0.0.mca");
  const cell = cellAt(preview, 0, 0);
  // Section Y=-4 spans blocks -64..-49, so the topmost block sits at height -48.
  assert.equal(cell.height, -48);
  assert.equal(cell.block, "minecraft:deepslate");
});

test("previewFromNbt marks a chunk unsupported when no section decodes", () => {
  const cases: Array<[string, Parameters<typeof nbtCompound>[0]]> = [
    ["no sections at all", {}],
    ["section without a palette", { sections: nbtList([nbtCompound({ Y: nbtByte(0) })]) }],
    ["section Y out of range", { sections: nbtList([nbtCompound({ Y: nbtInt(999), block_states: nbtCompound({ palette: nbtList([nbtCompound({ Name: nbtString("minecraft:stone") })]) }) })]) }]
  ];
  for (const [label, entries] of cases) {
    const preview = previewFromNbt(root(entries), 0, 0, 0, 0, "r.0.0.mca");
    assert.equal(preview.unsupportedReason, "该区块没有可解码的方块区段数据", label);
    assert.equal(preview.cells.length, 256, label);
  }
});

test("previewFromNbt rejects a data array whose length contradicts the palette width", () => {
  // 2 entries => 4 bits => 256 longs expected; supplying 100 must be refused, not misread.
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(3_465),
    sections: nbtList([nbtCompound({
      Y: nbtByte(0),
      block_states: nbtCompound({
        palette: nbtList([nbtCompound({ Name: nbtString(air) }), nbtCompound({ Name: nbtString("minecraft:stone") })]),
        data: nbtLongArray(new Array(100).fill(0n))
      })
    })])
  }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(preview.unsupportedReason, "该区块没有可解码的方块区段数据");
});

test("previewFromNbt rejects a multi-entry palette with no data array", () => {
  const preview = previewFromNbt(root({
    DataVersion: nbtInt(3_465),
    sections: nbtList([nbtCompound({
      Y: nbtByte(0),
      block_states: nbtCompound({
        palette: nbtList([nbtCompound({ Name: nbtString(air) }), nbtCompound({ Name: nbtString("minecraft:stone") })])
      })
    })])
  }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(preview.unsupportedReason, "该区块没有可解码的方块区段数据");
});

test("previewFromNbt falls back to air for a palette entry missing its Name", () => {
  const preview = previewFromNbt(root({
    sections: nbtList([nbtCompound({
      Y: nbtByte(0),
      block_states: nbtCompound({ palette: nbtList([nbtCompound({ Properties: nbtCompound({}) })]) })
    })])
  }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(cellAt(preview, 0, 0).block, air);
  assert.equal(cellAt(preview, 0, 0).height, 0);
});

test("previewFromNbt treats cave_air and void_air as air", () => {
  for (const block of ["minecraft:cave_air", "minecraft:void_air"]) {
    const preview = previewFromNbt(root({ sections: nbtList([uniformSection(0, block)]) }), 0, 0, 0, 0, "r.0.0.mca");
    assert.equal(cellAt(preview, 0, 0).height, 0, block);
  }
});

test("previewFromNbt surfaces DataVersion from either the root or Level", () => {
  const fromRoot = previewFromNbt(root({ DataVersion: nbtInt(3_465), sections: nbtList([uniformSection(0, "minecraft:stone")]) }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(fromRoot.dataVersion, 3_465);
  const fromLevel = previewFromNbt(root({ Level: nbtCompound({ DataVersion: nbtInt(1_976), Sections: nbtList([uniformSection(0, "minecraft:stone")]) }) }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(fromLevel.dataVersion, 1_976);
  const missing = previewFromNbt(root({ sections: nbtList([uniformSection(0, "minecraft:stone")]) }), 0, 0, 0, 0, "r.0.0.mca");
  assert.equal(missing.dataVersion, null);
});
