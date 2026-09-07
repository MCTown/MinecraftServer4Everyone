<script setup lang="ts">
import type {
  MapChunkPreview,
  MapChunkPreviewCell,
  MapMutationSelection,
  McaHeaderChunk,
  McaHeaderScan,
  McaRegionFile
} from "~/types/app";
import * as THREE from "three";

/** Camera scale (px per chunk) at which per-block terrain starts rendering. */
const previewScale = 28;
/** Camera scale at which cached block previews tint their chunks. */
const biomeZoom = 10;
/** Camera scale from which block previews are fetched for visible chunks. */
const previewFetchZoom = 16;
const maxCameraScale = 64;
const previewBatchSize = 128;
const maxPreviewBatches = 4;
const previewCacheLimit = 3_000;
/** Caps preview fetching per pass so mid-zoom tinting cannot hammer the server. */
const previewWantedCap = 1_500;

const props = defineProps<{
  serverId: string;
  regions: McaRegionFile[];
  regionTotal: number;
  selectedRegionPath: string;
  selectedHeader: McaHeaderScan | null;
  loadingSelectedHeader: boolean;
  selectedChunkKey: string;
  selectedChunks: Set<string>;
  mutationMode: MapMutationSelection["mode"];
  rectangle: { minX: number; minZ: number; maxX: number; maxZ: number };
}>();

const emit = defineEmits<{
  selectRegion: [region: McaRegionFile, header: McaHeaderScan | null];
  inspectChunk: [region: McaRegionFile, header: McaHeaderScan, chunk: McaHeaderChunk];
  toggleChunk: [region: McaRegionFile, header: McaHeaderScan, chunk: McaHeaderChunk];
}>();

const { api } = useApi();
const viewport = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const camera = reactive({ x: 0, y: 0, scale: 4 });
const canvasSize = reactive({ width: 0, height: 0, dpr: 1 });
const dragging = ref(false);
const loadingHeaders = reactive(new Set<string>());
const failedHeaders = reactive(new Set<string>());
const headerCache = shallowReactive(new Map<string, McaHeaderScan>());
const headerPromises = new Map<string, Promise<McaHeaderScan | null>>();
const previewCache = shallowReactive(new Map<string, MapChunkPreview>());
const previewBitmaps = new Map<string, HTMLCanvasElement>();
const pendingPreviews = reactive(new Set<string>());
const failedPreviews = reactive(new Set<string>());
const previewPromises = new Map<string, Promise<MapChunkPreview[] | null>>();
const hover = ref<{ chunkX: number; chunkZ: number; regionX: number; regionZ: number; localX: number; localZ: number; cellX: number; cellZ: number } | null>(null);

/** Block kinds found in loaded previews, shown in the legend once zoomed to block level. */
const legendCategories = ref<Array<{ label: string; color: string }>>([]);

function blockCategory(block: string): { label: string; color: string } | null {
  if (/grass|dirt|podzol|mycelium|moss|farmland|path/.test(block)) return { label: "草/土", color: "#64b549" };
  if (/water|kelp|seagrass/.test(block)) return { label: "水", color: "#4e94d8" };
  if (/sand|gravel/.test(block)) return { label: "沙/砾", color: "#d4c489" };
  if (/stone|deepslate|andesite|granite|diorite|tuff|basalt|netherrack|end_stone|ore|coal|copper|iron|gold|diamond/.test(block)) return { label: "石", color: "#868c92" };
  if (/log|leaves|planks|sapling|bamboo|mangrove/.test(block)) return { label: "树木", color: "#3a8636" };
  if (/snow|ice/.test(block)) return { label: "雪", color: "#cfe3ec" };
  return null;
}
const regionIndex = computed(() => new Map(props.regions.map((region) => [`${region.regionX}:${region.regionZ}`, region])));
const selectedRegion = computed(() => props.regions.find((region) => region.path === props.selectedRegionPath) ?? null);
const zoomPercent = computed(() => `${Math.round(camera.scale * 25)}%`);
const unitHint = computed(() => is3d.value
  ? "3D 高度场 · 左键旋转 · 滚轮缩放 · Shift/右键拖拽平移"
  : camera.scale >= previewScale ? "1 格 = 1 方块 · 每区块 16×16" : "1 格 = 1 区块");
const viewportLabel = computed(() => {
  const selected = selectedRegion.value ? `，当前区域 ${selectedRegion.value.regionX}, ${selectedRegion.value.regionZ}` : "";
  return `世界区块地图，共 ${props.regions.length} 个 MCA 区域${selected}`;
});
const coordinateStatus = computed(() => {
  if (hover.value) {
    const hint = hover.value;
    if (is3d.value || camera.scale >= previewScale) {
      const region = regionIndex.value.get(`${hint.regionX}:${hint.regionZ}`);
      const preview = region ? previewCache.get(previewKey(region.path, hint.localX, hint.localZ)) : undefined;
      const cell = preview?.cells.find((candidate) => candidate.localX === hint.cellX && candidate.localZ === hint.cellZ);
      if (cell && cell.height > 0) return `区块 X ${hint.chunkX} · Z ${hint.chunkZ} · ${cell.block} · Y=${cell.height}`;
    }
    return `区块 X ${hint.chunkX} · Z ${hint.chunkZ} · MCA ${hint.regionX},${hint.regionZ}`;
  }
  if (selectedRegion.value) return `MCA ${selectedRegion.value.regionX},${selectedRegion.value.regionZ} · ${selectedRegion.value.name}`;
  return "拖动画布浏览世界";
});

let resizeObserver: ResizeObserver | null = null;
let drawFrame = 0;
let headerTimer: ReturnType<typeof setTimeout> | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let pointer: { id: number; x: number; y: number; cameraX: number; cameraY: number; moved: boolean } | null = null;

/** BlueMap-style 3D heightfield view, built from the same preview data as the 2D tiles. */
const is3d = ref(false);
let threeScene: THREE.Scene | null = null;
let threeCamera: THREE.PerspectiveCamera | null = null;
let threeRenderer: THREE.WebGLRenderer | null = null;
let threeChunks: Array<{ preview: MapChunkPreview }> = [];
let threeBaseY = 0;
let terrainMesh: THREE.Mesh | null = null;
let waterMesh: THREE.Mesh | null = null;
let textureAtlas: THREE.CanvasTexture | null = null;
let hoverBox: THREE.LineSegments | null = null;
let threeFrame = 0;
let sceneRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let threeHoverKey = "";
let threeFitted = false;
const threeContextLost = ref(false);
/** Hard caps keep the GPU footprint bounded: 48 chunks × 256 columns, sides ≤ 8 rows. */
const threeChunkCap = 48;
const threeSideRowCap = 8;
const threeOrbit = { yaw: 0.85, pitch: 1.05, distance: 320, targetX: 0, targetZ: 0, targetY: 0 };
const threePointer = { active: false, mode: "orbit" as "orbit" | "pan", id: 0, x: 0, y: 0 };
const raycaster = new THREE.Raycaster();
const ndcPoint = new THREE.Vector2();
const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();

onMounted(() => {
  resizeObserver = new ResizeObserver(resizeCanvas);
  if (viewport.value) resizeObserver.observe(viewport.value);
  resizeCanvas();
  void nextTick(fitRegions);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (drawFrame) cancelAnimationFrame(drawFrame);
  if (headerTimer) clearTimeout(headerTimer);
  if (previewTimer) clearTimeout(previewTimer);
  dispose3d();
});

watch(() => props.regions, () => {
  headerCache.clear();
  headerPromises.clear();
  loadingHeaders.clear();
  failedHeaders.clear();
  previewCache.clear();
  previewBitmaps.clear();
  failedPreviews.clear();
  legendCategories.value = [];
  void nextTick(fitRegions);
});

watch(() => props.selectedHeader, (value) => {
  if (value) {
    headerCache.set(value.region.path, value);
    failedHeaders.delete(value.region.path);
    queueDraw();
    scheduleVisiblePreviews();
  }
});

watch(
  () => [props.selectedRegionPath, props.selectedChunkKey, props.selectedChunks, props.mutationMode, props.rectangle] as const,
  queueDraw,
  { deep: true }
);

watch(() => previewCache.size, () => {
  if (!is3d.value || !threeScene) return;
  if (sceneRebuildTimer) clearTimeout(sceneRebuildTimer);
  sceneRebuildTimer = setTimeout(() => {
    sceneRebuildTimer = null;
    threeBuildTerrain();
    if (!threeFitted) threeFit();
  }, 400);
});

function resizeCanvas() {
  const element = viewport.value;
  const target = canvas.value;
  if (!element || !target) return;
  const bounds = element.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasSize.width = Math.max(1, bounds.width);
  canvasSize.height = Math.max(1, bounds.height);
  canvasSize.dpr = dpr;
  target.width = Math.round(canvasSize.width * dpr);
  target.height = Math.round(canvasSize.height * dpr);
  if (is3d.value && threeRenderer && threeCamera) {
    threeRenderer.setPixelRatio(dpr);
    threeRenderer.setSize(canvasSize.width, canvasSize.height, false);
    threeCamera.aspect = canvasSize.width / canvasSize.height;
    threeCamera.updateProjectionMatrix();
  }
  queueDraw();
}

function queueDraw() {
  if (!import.meta.client || drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0;
    drawMap();
  });
}

function scheduleVisibleHeaders() {
  if (headerTimer) clearTimeout(headerTimer);
  headerTimer = setTimeout(() => {
    headerTimer = null;
    if (camera.scale < 0.7 || !canvasSize.width || !canvasSize.height) return;
    const left = (-camera.x / camera.scale) / 32 - 1;
    const right = ((canvasSize.width - camera.x) / camera.scale) / 32 + 1;
    const top = (-camera.y / camera.scale) / 32 - 1;
    const bottom = ((canvasSize.height - camera.y) / camera.scale) / 32 + 1;
    const centerX = (left + right) / 2;
    const centerZ = (top + bottom) / 2;
    const availableSlots = Math.max(0, 8 - headerPromises.size);
    const visible = props.regions
      .filter((region) => region.regionX >= left && region.regionX <= right && region.regionZ >= top && region.regionZ <= bottom)
      .sort((a, b) => Math.hypot(a.regionX - centerX, a.regionZ - centerZ) - Math.hypot(b.regionX - centerX, b.regionZ - centerZ))
      .filter((region) => !headerCache.has(region.path) && !headerPromises.has(region.path) && !failedHeaders.has(region.path))
      .slice(0, availableSlots);
    for (const region of visible) void loadHeader(region);
  }, 80);
}

async function loadHeader(region: McaRegionFile) {
  const cached = headerCache.get(region.path);
  if (cached) return cached;
  if (region.path === props.selectedRegionPath && props.loadingSelectedHeader) return null;
  if (failedHeaders.has(region.path)) return null;
  const pending = headerPromises.get(region.path);
  if (pending) return pending;

  const request = (async () => {
    loadingHeaders.add(region.path);
    queueDraw();
    try {
      const result = await api<McaHeaderScan>(`/api/servers/${props.serverId}/map/header?path=${encodeURIComponent(region.path)}`);
      if (props.regions.some((candidate) => candidate.path === region.path)) headerCache.set(region.path, result);
      return result;
    } catch {
      failedHeaders.add(region.path);
      return null;
    } finally {
      loadingHeaders.delete(region.path);
      headerPromises.delete(region.path);
      queueDraw();
      scheduleVisibleHeaders();
      scheduleVisiblePreviews();
    }
  })();
  headerPromises.set(region.path, request);
  return request;
}

function previewKey(regionPath: string, localX: number, localZ: number) {
  return `${regionPath}:${localX}:${localZ}`;
}

function shadeColor(hex: string, factor: number) {
  const value = parseInt(hex.slice(1), 16);
  const mix = (shift: number) => Math.min(255, Math.round(((value >> shift) & 255) * factor));
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

/** Overlays `overlay` (alpha `amount`) on top of `base`. */
function mixColor(base: string, overlay: string, amount: number) {
  const baseValue = parseInt(base.slice(1), 16);
  const overlayValue = parseInt(overlay.slice(1), 16);
  const mix = (shift: number) => Math.round(((baseValue >> shift) & 255) + (((overlayValue >> shift) & 255) - ((baseValue >> shift) & 255)) * amount);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

/**
 * Pre-renders a 32×32 terrain bitmap (2 px per block) in the spirit of BlueMap:
 * top faces lit by the sky above them, translucent surfaces composited over the
 * block underneath, concave corners darkened by ambient occlusion, and fully
 * dark cave mouths left as holes. The main loop only blits the bitmap.
 */
function previewBitmap(preview: MapChunkPreview) {
  const key = previewKey(preview.path, preview.localX, preview.localZ);
  const existing = previewBitmaps.get(key);
  if (existing) return existing;
  const bitmap = document.createElement("canvas");
  bitmap.width = 32;
  bitmap.height = 32;
  const context = bitmap.getContext("2d");
  if (context && preview.cells.length) {
    const byCell = new Map(preview.cells.map((cell) => [`${cell.localX}:${cell.localZ}`, cell]));
    for (const cell of preview.cells) {
      if (cell.height <= 0 || cell.light === 0) continue;
      const lightFactor = 0.8 + 0.2 * Math.min(15, cell.light) / 15;
      let face = shadeColor(cell.color, lightFactor);
      if (cell.water > 0) {
        const belowFactor = 0.8 + 0.2 * Math.min(15, cell.belowLight) / 15;
        const terrain = shadeColor(cell.below ?? cell.color, belowFactor);
        const surface = shadeColor(cell.color, lightFactor);
        face = mixColor(terrain, surface, Math.min(0.82, 0.42 + 0.1 * cell.water));
      }
      const x = cell.localX * 2;
      const z = cell.localZ * 2;
      context.fillStyle = face;
      context.fillRect(x, z, 2, 2);

      const higher = (dx: number, dz: number) => {
        const neighbor = byCell.get(`${cell.localX + dx}:${cell.localZ + dz}`);
        return neighbor !== undefined && neighbor.height > cell.height;
      };
      if (higher(0, -1)) { context.fillStyle = shadeColor(face, 0.8); context.fillRect(x, z, 2, 1); }
      if (higher(0, 1)) { context.fillStyle = shadeColor(face, 0.8); context.fillRect(x, z + 1, 2, 1); }
      if (higher(-1, 0)) { context.fillStyle = shadeColor(face, 0.8); context.fillRect(x, z, 1, 2); }
      if (higher(1, 0)) { context.fillStyle = shadeColor(face, 0.8); context.fillRect(x + 1, z, 1, 2); }
      const corner = (dx: number, dz: number) => higher(dx, 0) && higher(0, dz);
      if (corner(-1, -1)) { context.fillStyle = shadeColor(face, 0.7); context.fillRect(x, z, 1, 1); }
      if (corner(1, -1)) { context.fillStyle = shadeColor(face, 0.7); context.fillRect(x + 1, z, 1, 1); }
      if (corner(-1, 1)) { context.fillStyle = shadeColor(face, 0.7); context.fillRect(x, z + 1, 1, 1); }
      if (corner(1, 1)) { context.fillStyle = shadeColor(face, 0.7); context.fillRect(x + 1, z + 1, 1, 1); }
    }
  }
  previewBitmaps.set(key, bitmap);
  return bitmap;
}

async function loadPreviewBatch(region: McaRegionFile, coordinates: Array<{ localX: number; localZ: number; key: string }>) {
  if (!coordinates.length) return;
  const batchId = coordinates.map((coordinate) => coordinate.key).join("|");
  if (previewPromises.has(batchId)) return;
  const request = (async () => {
    for (const coordinate of coordinates) pendingPreviews.add(coordinate.key);
    queueDraw();
    try {
      const result = await api<MapChunkPreview[]>(`/api/servers/${props.serverId}/map/previews`, {
        method: "POST",
        body: { path: region.path, chunks: coordinates.map((coordinate) => ({ localX: coordinate.localX, localZ: coordinate.localZ })) }
      });
      for (const preview of result) {
        previewCache.set(previewKey(region.path, preview.localX, preview.localZ), preview);
        for (const cell of preview.cells) {
          const category = blockCategory(cell.block);
          if (category && !legendCategories.value.some((item) => item.label === category.label)) {
            legendCategories.value = [...legendCategories.value, category];
          }
        }
      }
      return result;
    } catch {
      for (const coordinate of coordinates) failedPreviews.add(coordinate.key);
      return null;
    } finally {
      for (const coordinate of coordinates) pendingPreviews.delete(coordinate.key);
      previewPromises.delete(batchId);
      queueDraw();
      scheduleVisiblePreviews();
    }
  })();
  previewPromises.set(batchId, request);
}

/** Loads 16×16 terrain for visible chunks so mid zoom can tint chunks and deep zoom can show blocks. */
function scheduleVisiblePreviews() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    if ((!is3d.value && camera.scale < previewFetchZoom) || !canvasSize.width || !canvasSize.height) return;
    let left: number;
    let right: number;
    let top: number;
    let bottom: number;
    if (is3d.value) {
      const radius = Math.max(24, threeOrbit.distance * 0.5);
      left = threeOrbit.targetX - radius;
      right = threeOrbit.targetX + radius;
      top = threeOrbit.targetZ - radius;
      bottom = threeOrbit.targetZ + radius;
    } else {
      left = -camera.x / camera.scale - 32;
      right = (canvasSize.width - camera.x) / camera.scale + 32;
      top = -camera.y / camera.scale - 32;
      bottom = (canvasSize.height - camera.y) / camera.scale + 32;
    }
    const centerX = (left + right) / 2;
    const centerZ = (top + bottom) / 2;

    const wanted: Array<{ region: McaRegionFile; localX: number; localZ: number; key: string; chunkX: number; chunkZ: number }> = [];
    for (const region of props.regions) {
      const worldX = region.regionX * 32;
      const worldZ = region.regionZ * 32;
      if (worldX > right || worldX + 32 < left || worldZ > bottom || worldZ + 32 < top) continue;
      const header = headerCache.get(region.path);
      if (!header) continue;
      for (const chunk of header.chunks) {
        const chunkX = worldX + chunk.localX;
        const chunkZ = worldZ + chunk.localZ;
        if (chunkX < left || chunkX > right || chunkZ < top || chunkZ > bottom) continue;
        const key = previewKey(region.path, chunk.localX, chunk.localZ);
        if (previewCache.has(key) || pendingPreviews.has(key) || failedPreviews.has(key)) continue;
        wanted.push({ region, localX: chunk.localX, localZ: chunk.localZ, key, chunkX, chunkZ });
      }
    }
    wanted.sort((a, b) => Math.hypot(a.chunkX - centerX, a.chunkZ - centerZ) - Math.hypot(b.chunkX - centerX, b.chunkZ - centerZ));
    wanted.splice(previewWantedCap);

    if (previewCache.size > previewCacheLimit) {
      const overflow = previewCache.size - previewCacheLimit;
      const oldest = previewCache.keys();
      for (let index = 0; index < overflow; index += 1) {
        const key = oldest.next().value as string | undefined;
        if (!key) break;
        previewCache.delete(key);
        previewBitmaps.delete(key);
        failedPreviews.delete(key);
      }
    }

    const byRegion = new Map<string, Array<{ localX: number; localZ: number; key: string }>>();
    for (const item of wanted) {
      const group = byRegion.get(item.region.path) ?? [];
      group.push({ localX: item.localX, localZ: item.localZ, key: item.key });
      byRegion.set(item.region.path, group);
    }

    for (const [regionPath, coordinates] of byRegion) {
      if (previewPromises.size >= maxPreviewBatches) break;
      const region = props.regions.find((candidate) => candidate.path === regionPath);
      if (!region) continue;
      for (let start = 0; start < coordinates.length && previewPromises.size < maxPreviewBatches; start += previewBatchSize) {
        void loadPreviewBatch(region, coordinates.slice(start, start + previewBatchSize));
      }
    }
  }, 120);
}

function fitRegions() {
  if (!props.regions.length || !canvasSize.width || !canvasSize.height) return;
  const minX = Math.min(...props.regions.map((region) => region.regionX * 32));
  const minZ = Math.min(...props.regions.map((region) => region.regionZ * 32));
  const maxX = Math.max(...props.regions.map((region) => (region.regionX + 1) * 32));
  const maxZ = Math.max(...props.regions.map((region) => (region.regionZ + 1) * 32));
  const padding = 44;
  camera.scale = clampScale(Math.min(
    (canvasSize.width - padding * 2) / Math.max(32, maxX - minX),
    (canvasSize.height - padding * 2) / Math.max(32, maxZ - minZ),
    14
  ));
  camera.x = (canvasSize.width - (maxX - minX) * camera.scale) / 2 - minX * camera.scale;
  camera.y = (canvasSize.height - (maxZ - minZ) * camera.scale) / 2 - minZ * camera.scale;
  cameraChanged();
}

function clampScale(scale: number) {
  return Math.min(maxCameraScale, Math.max(0.04, scale));
}

function zoomAt(nextScale: number, screenX: number, screenY: number) {
  const scale = clampScale(nextScale);
  const worldX = (screenX - camera.x) / camera.scale;
  const worldZ = (screenY - camera.y) / camera.scale;
  camera.scale = scale;
  camera.x = screenX - worldX * scale;
  camera.y = screenY - worldZ * scale;
  cameraChanged();
}

function zoomBy(factor: number) {
  zoomAt(camera.scale * factor, canvasSize.width / 2, canvasSize.height / 2);
}

function cameraChanged() {
  queueDraw();
  scheduleVisibleHeaders();
  scheduleVisiblePreviews();
}

function screenToChunk(screenX: number, screenY: number) {
  const chunkX = Math.floor((screenX - camera.x) / camera.scale);
  const chunkZ = Math.floor((screenY - camera.y) / camera.scale);
  const regionX = Math.floor(chunkX / 32);
  const regionZ = Math.floor(chunkZ / 32);
  return {
    chunkX,
    chunkZ,
    regionX,
    regionZ,
    localX: chunkX - regionX * 32,
    localZ: chunkZ - regionZ * 32
  };
}

function chunkAt(screenX: number, screenY: number) {
  const location = screenToChunk(screenX, screenY);
  const region = regionIndex.value.get(`${location.regionX}:${location.regionZ}`);
  if (!region) return { location, region: null, header: null, chunk: null };
  const header = headerCache.get(region.path) ?? null;
  const chunk = header?.chunks.find((candidate) => candidate.localX === location.localX && candidate.localZ === location.localZ) ?? null;
  return { location, region, header, chunk };
}

async function activateAt(screenX: number, screenY: number, toggle: boolean) {
  const hit = chunkAt(screenX, screenY);
  if (!hit.region) return;
  const header = hit.header ?? await loadHeader(hit.region);
  if (!header) {
    emit("selectRegion", hit.region, null);
    return;
  }
  const chunk = header.chunks.find((candidate) => candidate.localX === hit.location.localX && candidate.localZ === hit.location.localZ);
  if (!chunk) {
    emit("selectRegion", hit.region, header);
    return;
  }
  if (toggle) emit("toggleChunk", hit.region, header, chunk);
  else emit("inspectChunk", hit.region, header, chunk);
}

function selectFromMenu(event: Event) {
  const region = props.regions.find((candidate) => candidate.path === (event.target as HTMLSelectElement).value);
  if (!region) return;
  const cached = headerCache.get(region.path) ?? null;
  emit("selectRegion", region, cached);
  centerRegion(region);
}

function centerRegion(region: McaRegionFile) {
  const nextScale = Math.max(camera.scale, 5);
  camera.scale = clampScale(nextScale);
  camera.x = canvasSize.width / 2 - (region.regionX * 32 + 16) * camera.scale;
  camera.y = canvasSize.height / 2 - (region.regionZ * 32 + 16) * camera.scale;
  cameraChanged();
}

function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false };
  dragging.value = true;
  canvas.value?.setPointerCapture(event.pointerId);
}

function handlePointerMove(event: PointerEvent) {
  const target = canvas.value;
  if (!target) return;
  if (pointer?.id === event.pointerId) {
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    if (Math.hypot(deltaX, deltaY) > 4) pointer.moved = true;
    camera.x = pointer.cameraX + deltaX;
    camera.y = pointer.cameraY + deltaY;
    cameraChanged();
    return;
  }
  const bounds = target.getBoundingClientRect();
  const screenX = event.clientX - bounds.left;
  const screenY = event.clientY - bounds.top;
  const location = screenToChunk(screenX, screenY);
  const worldX = (screenX - camera.x) / camera.scale;
  const worldZ = (screenY - camera.y) / camera.scale;
  hover.value = {
    ...location,
    cellX: Math.min(15, Math.max(0, Math.floor((worldX - location.chunkX) * 16))),
    cellZ: Math.min(15, Math.max(0, Math.floor((worldZ - location.chunkZ) * 16)))
  };
  queueDraw();
}

function handlePointerUp(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const moved = pointer.moved;
  pointer = null;
  dragging.value = false;
  canvas.value?.releasePointerCapture(event.pointerId);
  if (!moved) {
    const bounds = canvas.value?.getBoundingClientRect();
    if (bounds) void activateAt(event.clientX - bounds.left, event.clientY - bounds.top, event.shiftKey);
  }
}

function handlePointerCancel(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer = null;
  dragging.value = false;
  canvas.value?.releasePointerCapture(event.pointerId);
}

function handleWheel(event: WheelEvent) {
  const target = canvas.value;
  if (!target) return;
  const bounds = target.getBoundingClientRect();
  const delta = Math.max(-120, Math.min(120, event.deltaY));
  zoomAt(camera.scale * Math.exp(-delta * 0.0025), event.clientX - bounds.left, event.clientY - bounds.top);
}

function handleContextMenu(event: MouseEvent) {
  event.preventDefault();
  void activateAt(event.offsetX, event.offsetY, true);
}

function handleKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 180 : 64;
  if (event.key === "ArrowLeft") camera.x += step;
  else if (event.key === "ArrowRight") camera.x -= step;
  else if (event.key === "ArrowUp") camera.y += step;
  else if (event.key === "ArrowDown") camera.y -= step;
  else if (event.key === "+" || event.key === "=") zoomBy(1.35);
  else if (event.key === "-") zoomBy(1 / 1.35);
  else if (event.key === "0") fitRegions();
  else return;
  event.preventDefault();
  cameraChanged();
}

function drawMap() {
  const target = canvas.value;
  const context = target?.getContext("2d");
  if (!target || !context) return;
  const { width, height, dpr } = canvasSize;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#101416";
  context.fillRect(0, 0, width, height);

  drawWorldGrid(context, width, height);
  const left = -camera.x / camera.scale - 32;
  const right = (width - camera.x) / camera.scale + 32;
  const top = -camera.y / camera.scale - 32;
  const bottom = (height - camera.y) / camera.scale + 32;
  for (const region of props.regions) {
    const worldX = region.regionX * 32;
    const worldZ = region.regionZ * 32;
    if (worldX > right || worldX + 32 < left || worldZ > bottom || worldZ + 32 < top) continue;
    drawRegion(context, region);
  }
}

function drawWorldGrid(context: CanvasRenderingContext2D, width: number, height: number) {
  const regionSize = 32 * camera.scale;
  if (regionSize < 10) return;
  const startX = ((camera.x % regionSize) + regionSize) % regionSize;
  const startY = ((camera.y % regionSize) + regionSize) % regionSize;
  context.beginPath();
  for (let x = startX; x < width; x += regionSize) { context.moveTo(x, 0); context.lineTo(x, height); }
  for (let y = startY; y < height; y += regionSize) { context.moveTo(0, y); context.lineTo(width, y); }
  context.strokeStyle = "rgba(255,255,255,0.045)";
  context.lineWidth = 1;
  context.stroke();
}

function drawRegion(context: CanvasRenderingContext2D, region: McaRegionFile) {
  const x = camera.x + region.regionX * 32 * camera.scale;
  const y = camera.y + region.regionZ * 32 * camera.scale;
  const size = 32 * camera.scale;
  const selected = region.path === props.selectedRegionPath;
  const header = headerCache.get(region.path);

  context.fillStyle = selected ? "rgba(102,194,219,0.13)" : "rgba(102,194,219,0.055)";
  context.fillRect(x, y, size, size);

  if (header && camera.scale >= 0.7) {
    context.imageSmoothingEnabled = false;
    for (const chunk of header.chunks) {
      const chunkX = x + chunk.localX * camera.scale;
      const chunkY = y + chunk.localZ * camera.scale;
      const preview = previewCache.get(previewKey(region.path, chunk.localX, chunk.localZ));
      if (preview && !preview.unsupportedReason && preview.cells.length && camera.scale >= biomeZoom) {
        context.drawImage(previewBitmap(preview), chunkX, chunkY, camera.scale, camera.scale);
      } else {
        context.fillStyle = chunk.valid ? "rgba(102,194,219,0.66)" : "rgba(219,102,86,0.88)";
        context.fillRect(chunkX + 0.4, chunkY + 0.4, Math.max(0.8, camera.scale - 0.8), Math.max(0.8, camera.scale - 0.8));
      }
    }
  }

  if (selected) drawSelection(context, x, y);
  if (camera.scale >= 5) drawChunkGrid(context, x, y, size);

  context.strokeStyle = selected ? "#c9f1fb" : failedHeaders.has(region.path) ? "rgba(219,102,86,0.85)" : "rgba(102,194,219,0.34)";
  context.lineWidth = selected ? 2 : 1;
  context.strokeRect(x + 0.5, y + 0.5, Math.max(0, size - 1), Math.max(0, size - 1));

  if (size >= 54) {
    const label = `${region.regionX},${region.regionZ}`;
    context.font = "11px 'IBM Plex Mono', monospace";
    const labelWidth = context.measureText(label).width + 10;
    context.fillStyle = "rgba(16,20,22,0.82)";
    context.fillRect(x + 5, y + 5, labelWidth, 20);
    context.fillStyle = selected ? "#c9f1fb" : "#aebabe";
    context.fillText(label, x + 10, y + 19);
  }
}

function drawChunkGrid(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
  context.beginPath();
  for (let index = 1; index < 32; index += 1) {
    const offset = index * camera.scale;
    context.moveTo(x + offset, y);
    context.lineTo(x + offset, y + size);
    context.moveTo(x, y + offset);
    context.lineTo(x + size, y + offset);
  }
  context.strokeStyle = "rgba(8,12,14,0.28)";
  context.lineWidth = 1;
  context.stroke();
}

function drawSelection(context: CanvasRenderingContext2D, x: number, y: number) {
  if (props.mutationMode === "rectangle") {
    const minX = Math.min(props.rectangle.minX, props.rectangle.maxX);
    const minZ = Math.min(props.rectangle.minZ, props.rectangle.maxZ);
    const maxX = Math.max(props.rectangle.minX, props.rectangle.maxX);
    const maxZ = Math.max(props.rectangle.minZ, props.rectangle.maxZ);
    context.fillStyle = "rgba(240,201,124,0.22)";
    context.strokeStyle = "#f0c97c";
    context.lineWidth = 2;
    context.fillRect(x + minX * camera.scale, y + minZ * camera.scale, (maxX - minX + 1) * camera.scale, (maxZ - minZ + 1) * camera.scale);
    context.strokeRect(x + minX * camera.scale, y + minZ * camera.scale, (maxX - minX + 1) * camera.scale, (maxZ - minZ + 1) * camera.scale);
  } else if (props.mutationMode === "region") {
    context.fillStyle = "rgba(240,201,124,0.12)";
    context.fillRect(x, y, 32 * camera.scale, 32 * camera.scale);
  } else {
    context.fillStyle = "rgba(240,201,124,0.44)";
    for (const key of props.selectedChunks) {
      const [localX = 0, localZ = 0] = key.split(":").map(Number);
      context.fillRect(x + localX * camera.scale, y + localZ * camera.scale, camera.scale, camera.scale);
    }
  }

  if (props.selectedChunkKey) {
    const [localX = 0, localZ = 0] = props.selectedChunkKey.split(":").map(Number);
    context.strokeStyle = "#f5fbfd";
    context.lineWidth = 2;
    context.strokeRect(x + localX * camera.scale + 1, y + localZ * camera.scale + 1, Math.max(1, camera.scale - 2), Math.max(1, camera.scale - 2));
  }
}

function shadeRgb(hex: string, factor: number): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [
    Math.min(255, Math.round(((value >> 16) & 255) * factor)) / 255,
    Math.min(255, Math.round(((value >> 8) & 255) * factor)) / 255,
    Math.min(255, Math.round((value & 255) * factor)) / 255
  ];
}

function hashSeed(name: string) {
  let value = 0;
  for (const character of name) value = (value * 31 + character.charCodeAt(0)) | 0;
  return value >>> 0;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(context: CanvasRenderingContext2D, rand: () => number, amount = 0.24) {
  const image = context.getImageData(0, 0, 16, 16);
  const data = image.data;
  for (let index = 0; index < 16 * 16; index += 1) {
    const factor = 1 + (rand() - 0.5) * amount;
    data[index * 4] = Math.min(255, data[index * 4]! * factor);
    data[index * 4 + 1] = Math.min(255, data[index * 4 + 1]! * factor);
    data[index * 4 + 2] = Math.min(255, data[index * 4 + 2]! * factor);
  }
  context.putImageData(image, 0, 0);
}

function darkenPixel(context: CanvasRenderingContext2D, x: number, y: number, factor: number) {
  const data = context.getImageData(x, y, 1, 1).data;
  const color = [data[0]! * factor, data[1]! * factor, data[2]! * factor].map((value) => Math.round(Math.min(255, value)));
  context.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  context.fillRect(x, y, 1, 1);
}

/**
 * Procedurally generated 16×16 block textures, baked into one atlas canvas so a
 * single three.js material can texture every face. Seeded per kind, so the
 * texture is stable across rebuilds.
 */
const TEXTURE_KINDS: Array<{ name: string; base: [number, number, number]; draw: (context: CanvasRenderingContext2D, rand: () => number) => void }> = [
  {
    name: "grass_top", base: [106, 178, 70],
    draw: (context, rand) => {
      for (let index = 0; index < 26; index += 1) darkenPixel(context, Math.floor(rand() * 16), Math.floor(rand() * 16), 0.82);
      speckle(context, rand);
    }
  },
  { name: "dirt", base: [134, 105, 74], draw: (context, rand) => speckle(context, rand) },
  { name: "sand", base: [216, 196, 138], draw: (context, rand) => speckle(context, rand) },
  { name: "stone", base: [134, 137, 140], draw: (context, rand) => speckle(context, rand) },
  { name: "deepslate", base: [92, 95, 99], draw: (context, rand) => speckle(context, rand) },
  {
    name: "leaves", base: [74, 140, 58],
    draw: (context, rand) => {
      for (let index = 0; index < 22; index += 1) {
        const x = Math.floor(rand() * 15);
        const y = Math.floor(rand() * 15);
        darkenPixel(context, x, y, 0.72);
        darkenPixel(context, x + 1, y, 0.85);
        darkenPixel(context, x, y + 1, 0.85);
      }
      speckle(context, rand, 0.3);
    }
  },
  {
    name: "log_side", base: [105, 82, 56],
    draw: (context, rand) => {
      for (let column = 0; column < 16; column += 5) {
        for (let y = 0; y < 16; y += 1) darkenPixel(context, column, y, 0.78);
        if (column + 1 < 16) for (let y = 0; y < 16; y += 1) darkenPixel(context, column + 1, y, 0.9);
      }
      speckle(context, rand);
    }
  },
  {
    name: "log_top", base: [163, 128, 86],
    draw: (context, rand) => {
      const center: [number, number] = [7.5, 7.5];
      for (let y = 0; y < 16; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          const distance = Math.hypot(x - center[0], y - center[1]);
          if (Math.floor(distance) % 3 === 0) darkenPixel(context, x, y, 0.85);
        }
      }
      speckle(context, rand);
    }
  },
  {
    name: "planks", base: [176, 148, 94],
    draw: (context, rand) => {
      for (let row = 0; row < 4; row += 1) {
        const y = row * 4;
        for (let x = 0; x < 16; x += 1) darkenPixel(context, x, y, 0.8);
        const seam = (row * 5) % 16;
        for (let offset = 0; offset < 4; offset += 1) darkenPixel(context, seam, y + offset, 0.82);
      }
      speckle(context, rand);
    }
  },
  { name: "snow", base: [234, 240, 246], draw: (context, rand) => speckle(context, rand, 0.1) },
  {
    name: "water", base: [70, 117, 190],
    draw: (context, rand) => {
      for (let index = 0; index < 12; index += 1) {
        const x = Math.floor(rand() * 16);
        const y = Math.floor(rand() * 16);
        const data = context.getImageData(x, y, 1, 1).data;
        const brighter = data.map((value) => Math.min(255, value + 26));
        context.fillStyle = `rgb(${brighter[0]},${brighter[1]},${brighter[2]})`;
        context.fillRect(x, y, 1, 1);
      }
      speckle(context, rand, 0.12);
    }
  },
  {
    name: "lava", base: [214, 110, 42],
    draw: (context, rand) => {
      for (let index = 0; index < 14; index += 1) {
        const x = Math.floor(rand() * 15);
        const y = Math.floor(rand() * 15);
        const bright = 40 + Math.floor(rand() * 60);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as Array<[number, number]>) {
          const data = context.getImageData(x + dx, y + dy, 1, 1).data;
          context.fillStyle = `rgb(${Math.min(255, data[0]! + bright)},${Math.min(255, data[1]! + bright * 0.6)},${Math.min(255, data[2]! + bright * 0.2)})`;
          context.fillRect(x + dx, y + dy, 1, 1);
        }
      }
      speckle(context, rand);
    }
  },
  { name: "ice", base: [168, 216, 232], draw: (context, rand) => speckle(context, rand, 0.08) },
  { name: "terracotta", base: [174, 106, 82], draw: (context, rand) => speckle(context, rand) },
  { name: "clay", base: [166, 167, 201], draw: (context, rand) => speckle(context, rand) },
  { name: "gravel", base: [143, 138, 135], draw: (context, rand) => speckle(context, rand, 0.3) },
  { name: "bedrock", base: [92, 92, 92], draw: (context, rand) => speckle(context, rand, 0.3) },
  { name: "cactus", base: [95, 158, 58], draw: (context, rand) => speckle(context, rand) },
  { name: "netherrack", base: [140, 63, 58], draw: (context, rand) => speckle(context, rand, 0.3) },
  { name: "glass", base: [207, 230, 232], draw: (context, rand) => speckle(context, rand, 0.06) },
  { name: "wool", base: [216, 210, 198], draw: (context, rand) => speckle(context, rand, 0.12) },
  { name: "default", base: [141, 140, 126], draw: (context, rand) => speckle(context, rand) }
];

const TEXTURE_INDEX = new Map(TEXTURE_KINDS.map((kind, index) => [kind.name, index]));
/** Atlas tile uv rects [u0, v0, u1, v1] per kind index. */
const TILE_UVS: Array<[number, number, number, number]> = TEXTURE_KINDS.map((_, index) => {
  const column = index % 8;
  const row = Math.floor(index / 8);
  return [column / 8, row / 8, (column + 1) / 8, (row + 1) / 8];
});

function texturePair(block: string): [number, number] {
  const kindOf = (name: string) => TEXTURE_INDEX.get(name) ?? TEXTURE_INDEX.get("default")!;
  if (/water|kelp|seagrass|bubble_column/.test(block)) return [kindOf("water"), kindOf("water")];
  if (/lava/.test(block)) return [kindOf("lava"), kindOf("lava")];
  if (/grass/.test(block)) return [kindOf("grass_top"), kindOf("dirt")];
  if (/leaves|moss/.test(block)) return [kindOf("leaves"), kindOf("leaves")];
  if (/sand/.test(block)) return [kindOf("sand"), kindOf("sand")];
  if (/snow/.test(block)) return [kindOf("snow"), kindOf("snow")];
  if (/ice/.test(block)) return [kindOf("ice"), kindOf("ice")];
  if (/deepslate/.test(block)) return [kindOf("deepslate"), kindOf("deepslate")];
  if (/stone|ore|coal|copper|iron|gold|diamond|emerald|lapis|redstone|quartz|andesite|granite|diorite|tuff|basalt|cobblestone|bricks|netherite/.test(block)) return [kindOf("stone"), kindOf("stone")];
  if (/terracotta/.test(block)) return [kindOf("terracotta"), kindOf("terracotta")];
  if (/clay/.test(block)) return [kindOf("clay"), kindOf("clay")];
  if (/gravel/.test(block)) return [kindOf("gravel"), kindOf("gravel")];
  if (/planks|slab|stairs|fence|gate|door|trapdoor/.test(block)) return [kindOf("planks"), kindOf("planks")];
  if (/log|wood|bark|stem|wart/.test(block)) return [kindOf("log_top"), kindOf("log_side")];
  if (/dirt|podzol|mycelium|farmland|path/.test(block)) return [kindOf("dirt"), kindOf("dirt")];
  if (/bedrock/.test(block)) return [kindOf("bedrock"), kindOf("bedrock")];
  if (/cactus/.test(block)) return [kindOf("cactus"), kindOf("cactus")];
  if (/netherrack|crimson|warped/.test(block)) return [kindOf("netherrack"), kindOf("netherrack")];
  if (/glass/.test(block)) return [kindOf("glass"), kindOf("glass")];
  if (/wool/.test(block)) return [kindOf("wool"), kindOf("wool")];
  return [kindOf("default"), kindOf("default")];
}

function buildTextureAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  for (const [index, kind] of TEXTURE_KINDS.entries()) {
    const x = (index % 8) * 16;
    const y = Math.floor(index / 8) * 16;
    context.fillStyle = `rgb(${kind.base[0]},${kind.base[1]},${kind.base[2]})`;
    context.fillRect(x, y, 16, 16);
    context.save();
    context.translate(x, y);
    kind.draw(context, mulberry32(hashSeed(kind.name)));
    context.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Appends a five-faced box (top + four sides, bottom omitted) as two triangles
 * per face. The top face carries `topTile`; the upper `rows` block-height bands
 * of the sides each carry `sideTile` (one texture tile per block, like a
 * Minecraft block face). Any deeper visible height is drawn as a single
 * stretched quad so tall cliffs stay cheap. Vertex colors carry the baked
 * light, so the atlas texture is multiplied by them.
 */
function pushBox(
  positions: number[], colors: number[], uvs: number[], chunkIds: number[], locals: number[],
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  topTile: number, sideTile: number, rows: number, remainder: number,
  topColor: [number, number, number], sideColor: [number, number, number],
  chunkIndex: number, local: number
) {
  const topUv = TILE_UVS[topTile]!;
  const sideUv = TILE_UVS[sideTile]!;
  const push = (
    a: [number, number, number], b: [number, number, number], c: [number, number, number],
    ua: [number, number], ub: [number, number], uc: [number, number],
    color: [number, number, number]
  ) => {
    for (const vertex of [a, b, c]) positions.push(vertex[0], vertex[1], vertex[2]);
    for (const uv of [ua, ub, uc]) uvs.push(uv[0], uv[1]);
    for (let index = 0; index < 3; index += 1) colors.push(color[0], color[1], color[2]);
    for (let index = 0; index < 3; index += 1) { chunkIds.push(chunkIndex); locals.push(local); }
  };
  const quad = (
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number],
    color: [number, number, number]
  ) => {
    push(a, b, c, ua, ub, uc, color);
    push(a, c, d, ua, uc, ud, color);
  };
  const sideFaces = (
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number],
    color: [number, number, number]
  ) => {
    quad(a, b, c, d, ua, ub, uc, ud, color);
  };
  push(
    [x0, y1, z0], [x1, y1, z1], [x1, y1, z0],
    [topUv[0], topUv[1]], [topUv[2], topUv[3]], [topUv[2], topUv[1]],
    topColor
  );
  push(
    [x0, y1, z0], [x0, y1, z1], [x1, y1, z1],
    [topUv[0], topUv[1]], [topUv[0], topUv[3]], [topUv[2], topUv[3]],
    topColor
  );
  for (let row = 0; row < rows; row += 1) {
    const rowTop = y1 - row;
    const rowBottom = rowTop - 1;
    const high: [number, number] = [sideUv[0], sideUv[1]];
    const low: [number, number] = [sideUv[0], sideUv[3]];
    const highWide: [number, number] = [sideUv[2], sideUv[1]];
    const lowWide: [number, number] = [sideUv[2], sideUv[3]];
    sideFaces(
      [x0, rowBottom, z0], [x1, rowTop, z0], [x1, rowBottom, z0], [x0, rowTop, z0],
      low, highWide, lowWide, high, sideColor
    );
    sideFaces(
      [x0, rowBottom, z1], [x1, rowBottom, z1], [x1, rowTop, z1], [x0, rowTop, z1],
      low, lowWide, highWide, high, sideColor
    );
    sideFaces(
      [x0, rowBottom, z0], [x0, rowBottom, z1], [x0, rowTop, z1], [x0, rowTop, z0],
      low, lowWide, highWide, high, sideColor
    );
    sideFaces(
      [x1, rowBottom, z0], [x1, rowTop, z1], [x1, rowBottom, z1], [x1, rowTop, z0],
      low, highWide, lowWide, high, sideColor
    );
  }
  if (remainder > 0) {
    const base = y1 - rows;
    const low: [number, number] = [sideUv[0], sideUv[3]];
    const high: [number, number] = [sideUv[0], sideUv[1]];
    const lowWide: [number, number] = [sideUv[2], sideUv[3]];
    const highWide: [number, number] = [sideUv[2], sideUv[1]];
    sideFaces(
      [x0, y0, z0], [x1, base, z0], [x1, y0, z0], [x0, base, z0],
      low, highWide, lowWide, high, sideColor
    );
    sideFaces(
      [x0, y0, z1], [x1, y0, z1], [x1, base, z1], [x0, base, z1],
      low, lowWide, highWide, high, sideColor
    );
    sideFaces(
      [x0, y0, z0], [x0, y0, z1], [x0, base, z1], [x0, base, z0],
      low, lowWide, highWide, high, sideColor
    );
    sideFaces(
      [x1, y0, z0], [x1, base, z1], [x1, y0, z1], [x1, base, z0],
      low, highWide, lowWide, high, sideColor
    );
  }
}

function threeBuildTerrain() {
  if (!is3d.value || !threeScene || !previewCache.size) return;
  const candidates: Array<{ preview: MapChunkPreview; distance: number }> = [];
  for (const preview of previewCache.values()) {
    if (preview.unsupportedReason || !preview.cells.length) continue;
    const dx = preview.chunkX - threeOrbit.targetX;
    const dz = preview.chunkZ - threeOrbit.targetZ;
    candidates.push({ preview, distance: dx * dx + dz * dz });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const chosen = candidates.slice(0, threeChunkCap).map((candidate) => candidate.preview);

  let minimum = Infinity;
  for (const preview of chosen) {
    for (const cell of preview.cells) {
      if (cell.height > 0 && cell.height < minimum) minimum = cell.height;
    }
  }
  threeBaseY = minimum === Infinity ? 0 : minimum - 3;

  const globalCells = new Map<string, MapChunkPreviewCell>();
  for (const preview of chosen) {
    for (const cell of preview.cells) {
      globalCells.set(`${preview.chunkX}:${preview.chunkZ}:${cell.localX}:${cell.localZ}`, cell);
    }
  }
  const neighborSurface = (chunkX: number, chunkZ: number, localX: number, localZ: number) => {
    const neighbor = globalCells.get(`${chunkX}:${chunkZ}:${localX}:${localZ}`);
    return neighbor ? neighbor.height : 0;
  };
  const maxNeighborSurface = (preview: MapChunkPreview, localX: number, localZ: number) => {
    const chunkX = preview.chunkX;
    const chunkZ = preview.chunkZ;
    return Math.max(
      neighborSurface(chunkX, chunkZ, localX - 1, localZ),
      neighborSurface(chunkX, chunkZ, localX + 1, localZ),
      neighborSurface(chunkX, chunkZ, localX, localZ - 1),
      neighborSurface(chunkX, chunkZ, localX, localZ + 1)
    );
  };

  const solidPositions: number[] = [];
  const solidColors: number[] = [];
  const solidUvs: number[] = [];
  const solidChunks: number[] = [];
  const solidLocals: number[] = [];
  const waterPositions: number[] = [];
  const waterColors: number[] = [];
  const waterUvs: number[] = [];
  const waterChunks: number[] = [];
  const waterLocals: number[] = [];
  threeChunks = [];

  for (const preview of chosen) {
    const chunkIndex = threeChunks.length;
    threeChunks.push({ preview });
    for (const cell of preview.cells) {
      if (cell.height <= 0 || cell.light === 0) continue;
      const x = preview.chunkX * 16 + cell.localX;
      const z = preview.chunkZ * 16 + cell.localZ;
      const local = cell.localX * 16 + cell.localZ;
      const lightFactor = 0.8 + 0.2 * Math.min(15, cell.light) / 15;
      const neighborMax = maxNeighborSurface(preview, cell.localX, cell.localZ);
      let terrainTop = cell.height;
      let waterTop: number | null = null;
      if (cell.water > 0) {
        terrainTop = Math.max(threeBaseY, cell.height - cell.water);
        waterTop = cell.height;
      }
      if (terrainTop > threeBaseY) {
        const belowFactor = 0.8 + 0.2 * Math.min(15, cell.belowLight) / 15;
        const base = cell.water > 0 ? cell.below ?? cell.color : cell.color;
        const topLight = cell.water > 0 ? belowFactor : lightFactor;
        const baseTiles = cell.water > 0 ? texturePair(cell.belowBlock ?? "minecraft:stone") : texturePair(cell.block);
        const visible = Math.max(0, Math.min(terrainTop - threeBaseY, terrainTop - neighborMax));
        const rows = Math.min(visible, threeSideRowCap);
        const remainder = visible - rows;
        pushBox(
          solidPositions, solidColors, solidUvs, solidChunks, solidLocals,
          x, threeBaseY, z, x + 1, terrainTop, z + 1,
          baseTiles[0], baseTiles[1], rows, remainder,
          shadeRgb(base, topLight), shadeRgb(base, topLight * 0.55),
          chunkIndex, local
        );
      }
      if (waterTop !== null && waterTop > terrainTop) {
        const tiles = texturePair("minecraft:water");
        const visible = Math.max(0, Math.min(waterTop - terrainTop, waterTop - neighborMax));
        const rows = Math.min(visible, threeSideRowCap);
        const remainder = visible - rows;
        pushBox(
          waterPositions, waterColors, waterUvs, waterChunks, waterLocals,
          x, terrainTop, z, x + 1, waterTop, z + 1,
          tiles[0], tiles[1], rows, remainder,
          shadeRgb(cell.color, lightFactor), shadeRgb(cell.color, lightFactor * 0.6),
          chunkIndex, local
        );
      }
    }
  }

  if (terrainMesh) { threeScene.remove(terrainMesh); terrainMesh.geometry.dispose(); (terrainMesh.material as THREE.Material).dispose(); terrainMesh = null; }
  if (waterMesh) { threeScene.remove(waterMesh); waterMesh.geometry.dispose(); (waterMesh.material as THREE.Material).dispose(); waterMesh = null; }
  if (solidPositions.length) {
    terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: textureAtlas, vertexColors: true }));
    terrainMesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute(solidPositions, 3));
    terrainMesh.geometry.setAttribute("uv", new THREE.Float32BufferAttribute(solidUvs, 2));
    terrainMesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(solidColors, 3));
    terrainMesh.geometry.setAttribute("aChunk", new THREE.Float32BufferAttribute(solidChunks, 1));
    terrainMesh.geometry.setAttribute("aLocal", new THREE.Float32BufferAttribute(solidLocals, 1));
    threeScene.add(terrainMesh);
  }
  if (waterPositions.length) {
    waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: textureAtlas, vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false }));
    waterMesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute(waterPositions, 3));
    waterMesh.geometry.setAttribute("uv", new THREE.Float32BufferAttribute(waterUvs, 2));
    waterMesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(waterColors, 3));
    waterMesh.geometry.setAttribute("aChunk", new THREE.Float32BufferAttribute(waterChunks, 1));
    waterMesh.geometry.setAttribute("aLocal", new THREE.Float32BufferAttribute(waterLocals, 1));
    threeScene.add(waterMesh);
  }
}

function threeUpdateCamera() {
  const camera = threeCamera;
  if (!camera) return;
  camera.position.set(
    threeOrbit.targetX + threeOrbit.distance * Math.cos(threeOrbit.pitch) * Math.sin(threeOrbit.yaw),
    threeOrbit.targetY + threeOrbit.distance * Math.sin(threeOrbit.pitch),
    threeOrbit.targetZ + threeOrbit.distance * Math.cos(threeOrbit.pitch) * Math.cos(threeOrbit.yaw)
  );
  camera.lookAt(threeOrbit.targetX, threeOrbit.targetY, threeOrbit.targetZ);
}

function threeRenderLoop() {
  if (!threeRenderer || !threeScene || !threeCamera) return;
  threeRenderer.render(threeScene, threeCamera);
  threeFrame = requestAnimationFrame(threeRenderLoop);
}

/**
 * Creates the WebGL renderer exactly once. The renderer is expensive and a
 * fresh `WebGLRenderer` cannot take over a disposed context reliably, so the
 * toggle only pauses and resumes this instance; it is torn down on unmount.
 */
function ensure3d() {
  const container = viewport.value;
  if (threeRenderer || !container) return;
  try {
    threeScene = new THREE.Scene();
    threeCamera = new THREE.PerspectiveCamera(55, canvasSize.width / Math.max(1, canvasSize.height), 0.1, 4_000);
    textureAtlas = buildTextureAtlas();
    threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    threeRenderer.setSize(canvasSize.width, canvasSize.height, false);
    threeRenderer.domElement.className = "map-viewport-webgl";
    threeRenderer.domElement.tabIndex = 0;
    threeRenderer.domElement.setAttribute("aria-label", "3D 高度场地形视图，可旋转、缩放和平移");
    threeRenderer.domElement.addEventListener("pointerdown", threePointerDown);
    threeRenderer.domElement.addEventListener("pointermove", threePointerMove);
    threeRenderer.domElement.addEventListener("pointerup", threePointerUp);
    threeRenderer.domElement.addEventListener("pointercancel", threePointerCancel);
    threeRenderer.domElement.addEventListener("pointerleave", threePointerLeave);
    threeRenderer.domElement.addEventListener("wheel", threeWheel, { passive: false });
    threeRenderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    threeRenderer.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      threeContextLost.value = true;
      console.warn("3D 视图的 WebGL 上下文丢失，将在下次打开时重建渲染器");
    });
    container.appendChild(threeRenderer.domElement);
    hoverBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xc9f1fb, transparent: true, opacity: 0.95, depthTest: false })
    );
    hoverBox.visible = false;
    threeScene.add(hoverBox);
  } catch (error) {
    console.error("无法初始化 3D 视图", error);
    threeScene = null;
    threeCamera = null;
    threeRenderer = null;
    threeChunks = [];
    is3d.value = false;
  }
}

/** Resumes a paused 3D view: rebuilds the terrain from the preview cache and restarts the loop. */
function show3d() {
  if (threeContextLost.value) {
    dispose3d();
    ensure3d();
  }
  if (!threeRenderer) return;
  threeRenderer.domElement.style.display = "block";
  threeBuildTerrain();
  threeFit();
  if (!threeFrame) threeRenderLoop();
  scheduleVisiblePreviews();
}

/** Tears down and recreates the renderer, used by the visible recovery button. */
function rebuild3d() {
  dispose3d();
  ensure3d();
  if (threeRenderer) show3d();
}

/** Pauses the 3D view without releasing the renderer, so reopening is instant. */
function pause3d() {
  if (threeFrame) cancelAnimationFrame(threeFrame);
  threeFrame = 0;
  if (sceneRebuildTimer) clearTimeout(sceneRebuildTimer);
  sceneRebuildTimer = null;
  if (hoverBox) hoverBox.visible = false;
  threeHoverKey = "";
  threeFitted = false;
  threeChunks = [];
  hover.value = null;
  if (threeRenderer) threeRenderer.domElement.style.display = "none";
}

/** Full teardown, used when the component unmounts or the context is lost. */
function dispose3d() {
  pause3d();
  threeContextLost.value = false;
  const renderer = threeRenderer;
  if (renderer) {
    renderer.domElement.removeEventListener("pointerdown", threePointerDown);
    renderer.domElement.removeEventListener("pointermove", threePointerMove);
    renderer.domElement.removeEventListener("pointerup", threePointerUp);
    renderer.domElement.removeEventListener("pointercancel", threePointerCancel);
    renderer.domElement.removeEventListener("pointerleave", threePointerLeave);
    renderer.domElement.removeEventListener("wheel", threeWheel);
    renderer.domElement.remove();
    try {
      renderer.dispose();
      renderer.forceContextLoss();
    } catch {
      // The context may already be gone; nothing left to release.
    }
  }
  for (const mesh of [terrainMesh, waterMesh]) {
    if (mesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
  }
  hoverBox?.geometry.dispose();
  (hoverBox?.material as THREE.Material | undefined)?.dispose();
  textureAtlas?.dispose();
  textureAtlas = null;
  threeScene = null;
  threeCamera = null;
  threeRenderer = null;
  terrainMesh = null;
  waterMesh = null;
  hoverBox = null;
}

function toggle3d() {
  is3d.value = !is3d.value;
  if (is3d.value) {
    ensure3d();
    if (threeRenderer) show3d();
  } else {
    pause3d();
    queueDraw();
  }
}

function threeFit() {
  const camera = threeCamera;
  if (!camera || !threeChunks.length) return;
  threeFitted = true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (const { preview } of threeChunks) {
    minX = Math.min(minX, preview.chunkX * 16);
    maxX = Math.max(maxX, (preview.chunkX + 1) * 16);
    minZ = Math.min(minZ, preview.chunkZ * 16);
    maxZ = Math.max(maxZ, (preview.chunkZ + 1) * 16);
    for (const cell of preview.cells) maxY = Math.max(maxY, cell.height);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 32);
  threeOrbit.targetX = (minX + maxX) / 2;
  threeOrbit.targetZ = (minZ + maxZ) / 2;
  threeOrbit.targetY = (threeBaseY + maxY) / 2;
  threeOrbit.distance = Math.min(1_600, Math.max(40, span * 1.35 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
  threeUpdateCamera();
}

function threeDolly(factor: number) {
  threeOrbit.distance = Math.min(1_600, Math.max(40, threeOrbit.distance * factor));
  threeUpdateCamera();
}

function threePointerDown(event: PointerEvent) {
  if (!threeRenderer) return;
  threeRenderer.domElement.setPointerCapture(event.pointerId);
  threePointer.active = true;
  threePointer.mode = event.shiftKey || event.button === 2 ? "pan" : "orbit";
  threePointer.id = event.pointerId;
  threePointer.x = event.clientX;
  threePointer.y = event.clientY;
}

function threePointerMove(event: PointerEvent) {
  const target = threeRenderer?.domElement;
  if (!target) return;
  if (threePointer.active && threePointer.id === event.pointerId) {
    const dx = event.clientX - threePointer.x;
    const dy = event.clientY - threePointer.y;
    threePointer.x = event.clientX;
    threePointer.y = event.clientY;
    if (threePointer.mode === "pan" && threeCamera) {
      cameraRight.setFromMatrixColumn(threeCamera.matrix, 0);
      cameraUp.setFromMatrixColumn(threeCamera.matrix, 1);
      const factor = threeOrbit.distance * 0.0012;
      threeOrbit.targetX += (-dx * cameraRight.x + dy * cameraUp.x) * factor;
      threeOrbit.targetY += (-dx * cameraRight.y + dy * cameraUp.y) * factor;
      threeOrbit.targetZ += (-dx * cameraRight.z + dy * cameraUp.z) * factor;
    } else {
      threeOrbit.yaw -= dx * 0.006;
      threeOrbit.pitch = Math.min(1.45, Math.max(0.12, threeOrbit.pitch - dy * 0.006));
    }
    threeUpdateCamera();
    return;
  }
  threeHover(event);
}

function threePointerUp(event: PointerEvent) {
  if (!threePointer.active || threePointer.id !== event.pointerId) return;
  threePointer.active = false;
  if (threePointer.mode === "pan") {
    if (sceneRebuildTimer) clearTimeout(sceneRebuildTimer);
    sceneRebuildTimer = setTimeout(() => { sceneRebuildTimer = null; threeBuildTerrain(); scheduleVisiblePreviews(); }, 500);
  }
  threeRenderer?.domElement.releasePointerCapture(event.pointerId);
}

function threePointerCancel(event: PointerEvent) {
  if (!threePointer.active || threePointer.id !== event.pointerId) return;
  threePointer.active = false;
  threeRenderer?.domElement.releasePointerCapture(event.pointerId);
}

function threePointerLeave() {
  if (threePointer.active) return;
  threeHoverKey = "";
  hover.value = null;
  if (hoverBox) hoverBox.visible = false;
}

function threeWheel(event: WheelEvent) {
  event.preventDefault();
  threeOrbit.distance = Math.min(1_600, Math.max(40, threeOrbit.distance * Math.exp(Math.max(-120, Math.min(120, event.deltaY)) * 0.0012)));
  threeUpdateCamera();
}

function threeHover(event: PointerEvent) {
  if (!threeCamera || !threeRenderer || (!terrainMesh && !waterMesh)) return;
  const bounds = threeRenderer.domElement.getBoundingClientRect();
  ndcPoint.set(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1
  );
  raycaster.setFromCamera(ndcPoint, threeCamera);
  const hits = raycaster.intersectObjects([terrainMesh, waterMesh].filter((mesh): mesh is THREE.Mesh => mesh !== null), false);
  if (!hits.length) {
    threeHoverKey = "";
    hover.value = null;
    if (hoverBox) hoverBox.visible = false;
    return;
  }
  const hitObject = hits[0]!.object as THREE.Mesh;
  const geometry = hitObject.geometry;
  const vertex = (hits[0]!.faceIndex ?? 0) * 3;
  const chunkIndex = geometry.getAttribute("aChunk").getX(vertex);
  const local = geometry.getAttribute("aLocal").getX(vertex);
  const preview = threeChunks[chunkIndex]?.preview;
  if (!preview) return;
  const localX = Math.floor(local / 16);
  const localZ = local % 16;
  const key = `${preview.chunkX}:${preview.chunkZ}:${localX}:${localZ}`;
  hover.value = {
    chunkX: preview.chunkX,
    chunkZ: preview.chunkZ,
    regionX: preview.regionX,
    regionZ: preview.regionZ,
    localX: preview.localX,
    localZ: preview.localZ,
    cellX: localX,
    cellZ: localZ
  };
  if (threeHoverKey !== key && hoverBox) {
    threeHoverKey = key;
    const cell = preview.cells.find((candidate) => candidate.localX === localX && candidate.localZ === localZ);
    const x = preview.chunkX * 16 + localX;
    const z = preview.chunkZ * 16 + localZ;
    const top = cell?.height ?? threeBaseY + 1;
    hoverBox.scale.set(1.02, Math.max(1, top - threeBaseY), 1.02);
    hoverBox.position.set(x + 0.5, (threeBaseY + top) / 2, z + 0.5);
    hoverBox.visible = true;
  }
}
</script>

<template>
  <section class="map-viewport-shell" aria-labelledby="map-viewport-title">
    <div class="map-viewport-toolbar">
      <div>
        <span id="map-viewport-title">世界区块地图</span>
        <code>{{ regions.length }} / {{ regionTotal }} MCA</code>
      </div>
      <label class="map-region-select">
        <span>区域</span>
        <select :value="selectedRegionPath" @change="selectFromMenu">
          <option value="" disabled>定位 MCA 区域</option>
          <option v-for="region in regions" :key="region.path" :value="region.path">{{ region.regionX }},{{ region.regionZ }} · {{ region.name }}</option>
        </select>
      </label>
      <div class="map-zoom-controls" aria-label="地图缩放">
        <button type="button" :class="{ active: is3d }" title="切换 3D 高度场视图" :aria-pressed="is3d" @click="toggle3d">3D</button>
        <button type="button" title="缩小" aria-label="缩小地图" @click="is3d ? threeDolly(1 / 1.35) : zoomBy(1 / 1.35)">-</button>
        <output aria-label="当前缩放比例">{{ is3d ? "3D" : zoomPercent }}</output>
        <button type="button" title="放大" aria-label="放大地图" @click="is3d ? threeDolly(1.35) : zoomBy(1.35)">+</button>
        <button type="button" title="显示全部区域" @click="is3d ? threeFit() : fitRegions()">适配</button>
      </div>
    </div>

    <div
      ref="viewport"
      class="map-viewport"
      :class="{ dragging }"
    >
      <canvas
        ref="canvas"
        v-show="!is3d"
        tabindex="0"
        :aria-label="viewportLabel"
        aria-describedby="map-viewport-help"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @pointerleave="hover = null"
        @wheel.prevent="handleWheel"
        @contextmenu="handleContextMenu"
        @keydown="handleKeydown"
      />
      <p id="map-viewport-help" class="visually-hidden">拖动可平移地图，滚轮可围绕指针缩放。中缩放时已加载的区块按地形着色，放大后区块内直接渲染 16×16 方块材质，悬停显示方块名称。点击已占用区块进行高亮，按住 Shift 点击或使用右键可切换删除选择。3D 视图中左键旋转、滚轮缩放、Shift 或右键拖拽平移，悬停显示方块。方向键平移，加减键缩放，数字零显示全部区域。</p>
      <div v-if="is3d || camera.scale >= previewScale" class="map-viewport-legend map-viewport-legend-terrain" aria-hidden="true">
        <span v-for="category in legendCategories" :key="category.label" class="terrain" :style="{ '--swatch': category.color }">{{ category.label }}</span>
        <span v-if="!legendCategories.length">方块材质加载中</span>
        <span class="invalid">异常</span>
      </div>
      <div v-else class="map-viewport-legend" aria-hidden="true">
        <span class="occupied">已占用</span>
        <span class="selected">已选择</span>
        <span class="invalid">异常</span>
      </div>
      <span v-if="loadingHeaders.size || pendingPreviews.size" class="map-viewport-loading">读取 {{ loadingHeaders.size }} 个 MCA 头{{ pendingPreviews.size ? ` · ${pendingPreviews.size} 个区块材质` : "" }}</span>
      <div v-if="threeContextLost && is3d" class="map-viewport-error" role="alert">
        <span>3D 视图的图形上下文已丢失，请重建</span>
        <button type="button" @click="rebuild3d">重建</button>
      </div>
    </div>

    <footer class="map-viewport-status">
      <code>{{ coordinateStatus }}</code>
      <span>{{ unitHint }}</span>
    </footer>
  </section>
</template>
