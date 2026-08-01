<script setup lang="ts">
import type {
  MapMutationSelection,
  McaHeaderChunk,
  McaHeaderScan,
  McaRegionFile
} from "~/types/app";

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
const hover = ref<{ chunkX: number; chunkZ: number; regionX: number; regionZ: number } | null>(null);
const regionIndex = computed(() => new Map(props.regions.map((region) => [`${region.regionX}:${region.regionZ}`, region])));
const selectedRegion = computed(() => props.regions.find((region) => region.path === props.selectedRegionPath) ?? null);
const zoomPercent = computed(() => `${Math.round(camera.scale * 25)}%`);
const viewportLabel = computed(() => {
  const selected = selectedRegion.value ? `，当前区域 ${selectedRegion.value.regionX}, ${selectedRegion.value.regionZ}` : "";
  return `世界区块地图，共 ${props.regions.length} 个 MCA 区域${selected}`;
});
const coordinateStatus = computed(() => {
  if (hover.value) return `区块 X ${hover.value.chunkX} · Z ${hover.value.chunkZ} · MCA ${hover.value.regionX},${hover.value.regionZ}`;
  if (selectedRegion.value) return `MCA ${selectedRegion.value.regionX},${selectedRegion.value.regionZ} · ${selectedRegion.value.name}`;
  return "拖动画布浏览世界";
});

let resizeObserver: ResizeObserver | null = null;
let drawFrame = 0;
let headerTimer: ReturnType<typeof setTimeout> | null = null;
let pointer: { id: number; x: number; y: number; cameraX: number; cameraY: number; moved: boolean } | null = null;

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
});

watch(() => props.regions, () => {
  headerCache.clear();
  headerPromises.clear();
  loadingHeaders.clear();
  failedHeaders.clear();
  void nextTick(fitRegions);
});

watch(() => props.selectedHeader, (value) => {
  if (value) {
    headerCache.set(value.region.path, value);
    failedHeaders.delete(value.region.path);
    queueDraw();
  }
});

watch(
  () => [props.selectedRegionPath, props.selectedChunkKey, props.selectedChunks, props.mutationMode, props.rectangle] as const,
  queueDraw,
  { deep: true }
);

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
    }
  })();
  headerPromises.set(region.path, request);
  return request;
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
  return Math.min(28, Math.max(0.04, scale));
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
  const location = screenToChunk(event.clientX - bounds.left, event.clientY - bounds.top);
  hover.value = location;
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
    for (const chunk of header.chunks) {
      const chunkX = x + chunk.localX * camera.scale;
      const chunkY = y + chunk.localZ * camera.scale;
      context.fillStyle = chunk.valid ? "rgba(102,194,219,0.66)" : "rgba(219,102,86,0.88)";
      context.fillRect(chunkX + 0.4, chunkY + 0.4, Math.max(0.8, camera.scale - 0.8), Math.max(0.8, camera.scale - 0.8));
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
        <button type="button" title="缩小" aria-label="缩小地图" @click="zoomBy(1 / 1.35)">-</button>
        <output aria-label="当前缩放比例">{{ zoomPercent }}</output>
        <button type="button" title="放大" aria-label="放大地图" @click="zoomBy(1.35)">+</button>
        <button type="button" title="显示全部区域" @click="fitRegions">适配</button>
      </div>
    </div>

    <div
      ref="viewport"
      class="map-viewport"
      :class="{ dragging }"
    >
      <canvas
        ref="canvas"
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
      <p id="map-viewport-help" class="visually-hidden">拖动可平移地图，滚轮可围绕指针缩放。点击已占用区块进行预览，按住 Shift 点击或使用右键可切换删除选择。方向键平移，加减键缩放，数字零显示全部区域。</p>
      <div class="map-viewport-legend" aria-hidden="true">
        <span class="occupied">已占用</span>
        <span class="selected">已选择</span>
        <span class="invalid">异常</span>
      </div>
      <span v-if="loadingHeaders.size" class="map-viewport-loading">读取 {{ loadingHeaders.size }} 个 MCA 头</span>
    </div>

    <footer class="map-viewport-status">
      <code>{{ coordinateStatus }}</code>
      <span>1 格 = 1 区块</span>
    </footer>
  </section>
</template>
