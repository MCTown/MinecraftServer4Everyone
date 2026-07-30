<script setup lang="ts">
import type { FileEntry, ServerRecord } from "~/types/app";
import type { UploadState } from "~/types/ui";

const props = defineProps<{
  currentPath: string;
  downloadUrl: (path: string) => string;
  files: FileEntry[];
  loading: boolean;
  parentDirectoryPath: string;
  selectedFile: FileEntry | null;
  selectedFilePaths: string[];
  selectedFiles: FileEntry[];
  server: ServerRecord;
  upload: UploadState;
  uploadDetail: (upload: UploadState) => string;
  formatBytes: (size: number) => string;
}>();

const emit = defineEmits<{
  "begin-selection": [path: string, event: MouseEvent];
  close: [];
  "create-file": [name: string];
  "create-folder": [name: string];
  "drag-select": [path: string];
  "go-up": [];
  "open-entry": [file: FileEntry];
  "open-folder": [path: string];
  "remove-selected": [];
  "rename-file": [path: string];
  refresh: [];
  "show-properties": [file: FileEntry];
  "toggle-selected": [path: string];
  upload: [event: Event];
}>();

const uploadInput = ref<HTMLInputElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const createDialog = ref<HTMLElement | null>(null);
const dropdownOpen = ref(false);
const createDialogOpen = ref(false);
const createDialogType = ref<"folder" | "file">("folder");
const createInputName = ref("");
const createInputRef = ref<HTMLInputElement | null>(null);
const createTrigger = ref<HTMLButtonElement | null>(null);

function requestUpload() {
  uploadInput.value?.click();
}

function focusInitialAction() {
  closeButton.value?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (createDialogOpen.value) return;
  if (event.key === "Escape") {
    emit("close");
    return;
  }
  if (event.key !== "Tab" || !dialog.value) return;
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleCreateKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelCreate();
    return;
  }
  if (event.key !== "Tab" || !createDialog.value) return;
  const focusable = [...createDialog.value.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openCreate(type: "folder" | "file") {
  createDialogType.value = type;
  createInputName.value = "";
  dropdownOpen.value = false;
  createDialogOpen.value = true;
  nextTick(() => createInputRef.value?.focus());
}

function confirmCreate() {
  const name = createInputName.value.trim();
  if (!name) return;
  if (createDialogType.value === "folder") {
    emit("create-folder", name);
  } else {
    emit("create-file", name);
  }
  createDialogOpen.value = false;
  createInputName.value = "";
  void nextTick(() => createTrigger.value?.focus());
}

function cancelCreate() {
  createDialogOpen.value = false;
  createInputName.value = "";
  void nextTick(() => createTrigger.value?.focus());
}

function downloadSelected() {
  const filesToDownload = props.selectedFiles.filter((f) => f.type === "file");
  filesToDownload.forEach((file, index) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = props.downloadUrl(`/api/servers/${props.server.id}/files/download?path=${encodeURIComponent(file.path)}`);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, index * 200);
  });
}

function fileType(file: FileEntry): string {
  if (file.type === "directory") return "文件夹";
  const parts = file.name.split(".");
  if (parts.length > 1) {
    const ext = parts.pop()!.toUpperCase();
    return `${ext} 文件`;
  }
  return "文件";
}

defineExpose({ requestUpload, focusInitialAction });
</script>

<template>
  <section ref="dialog" class="card stack management-dialog files-dialog" role="dialog" aria-modal="true" :aria-label="`${props.server.name} 文件管理器`" @keydown="handleKeydown">
    <!-- Inline create dialog overlay -->
    <div v-if="createDialogOpen" class="create-name-overlay" @click.self="cancelCreate">
      <div ref="createDialog" class="create-name-dialog card" role="dialog" aria-modal="true" :aria-label="createDialogType === 'folder' ? '新建文件夹' : '新建文件'" @keydown.stop="handleCreateKeydown">
        <p class="eyebrow">{{ createDialogType === "folder" ? "新建文件夹" : "新建文件" }}</p>
        <input
          ref="createInputRef"
          v-model="createInputName"
          :aria-label="createDialogType === 'folder' ? '文件夹名称' : '文件名称'"
          :placeholder="createDialogType === 'folder' ? '文件夹名称' : '文件名称'"
          @keydown.enter="confirmCreate"
        />
        <div class="row">
          <button type="button" @click="cancelCreate">取消</button>
          <button type="button" class="primary" :disabled="!createInputName.trim()" @click="confirmCreate">确认</button>
        </div>
      </div>
    </div>

    <div class="card-header">
      <div>
        <p class="eyebrow">File Manager</p>
        <h2 class="card-title">{{ props.server.name }} 文件</h2>
        <p class="muted">当前路径：{{ props.currentPath }}</p>
      </div>
      <div class="row">
        <button v-if="props.selectedFiles.filter(f => f.type === 'file').length > 0" type="button" @click="downloadSelected">下载</button>
        <button type="button" @click="emit('go-up')">上级</button>
        <button type="button" @click="emit('refresh')">刷新</button>
        <button ref="closeButton" type="button" @click="emit('close')">关闭</button>
      </div>
    </div>

    <div class="row file-toolbar">
      <!-- Dropdown: 新建 -->
      <div class="new-dropdown">
        <button ref="createTrigger" type="button" @click="dropdownOpen = !dropdownOpen">新建 ▾</button>
        <div v-if="dropdownOpen" class="new-dropdown-backdrop" @click="dropdownOpen = false" />
        <div v-if="dropdownOpen" class="new-dropdown-menu">
          <button type="button" class="new-dropdown-item" @click="openCreate('folder')">
            <span class="new-dropdown-icon file-icon file-icon-directory" aria-hidden="true" />
            新建文件夹
          </button>
          <button type="button" class="new-dropdown-item" @click="openCreate('file')">
            <span class="new-dropdown-icon file-icon file-icon-file" aria-hidden="true" />
            新建文件
          </button>
        </div>
      </div>

      <input ref="uploadInput" class="visually-hidden" type="file" tabindex="-1" @change="emit('upload', $event)" />
      <button type="button" :disabled="props.upload.active" @click="requestUpload">{{ props.upload.active ? "上传中" : "上传文件" }}</button>

      <template v-if="props.selectedFiles.length > 0">
        <span class="file-selection-count">已选 {{ props.selectedFiles.length }} 项</span>
        <button v-if="props.selectedFile" type="button" @click="emit('show-properties', props.selectedFile)">属性</button>
        <button v-if="props.selectedFile" type="button" @click="emit('rename-file', props.selectedFile.path)">重命名</button>
        <button class="danger" type="button" @click="emit('remove-selected')">删除</button>
      </template>
    </div>

    <div v-if="props.upload.active" class="upload-progress" role="status" aria-live="polite">
      <div class="row"><strong>{{ props.upload.done ? "上传完成" : "正在上传" }} {{ props.upload.fileName }}</strong><span>{{ props.upload.percent }}%</span></div>
      <div class="progress-track"><span :style="{ width: `${props.upload.percent}%` }" /></div>
      <small class="muted">{{ props.uploadDetail(props.upload) }}</small>
    </div>

    <div class="file-list-pane">
      <div class="file-list-header" aria-hidden="true">
        <div></div>
        <div>名称</div>
        <div>类型</div>
        <div>大小</div>
      </div>
      <div class="file-list dialog-file-list">
        <div v-if="props.loading" key="loading" class="file-row file-loading-row"><span class="file-loading-spinner" aria-hidden="true" /><span class="muted">正在获取文件...</span></div>
        <div v-else-if="props.files.length === 0" key="empty" class="file-row empty-row"><span class="muted">当前目录为空</span></div>
        <div v-if="!props.loading && props.parentDirectoryPath" class="file-row file-row-parent" role="button" tabindex="0" @click="emit('open-folder', props.parentDirectoryPath)" @keydown.enter="emit('open-folder', props.parentDirectoryPath)" @keydown.space.prevent="emit('open-folder', props.parentDirectoryPath)">
          <div class="file-col-check-placeholder"></div>
          <div class="file-col-name">
            <span class="file-icon file-icon-parent" aria-hidden="true" />
            <span class="visually-hidden">上一级</span>
            <span>../</span>
          </div>
          <div class="file-col-type muted">文件夹</div>
          <div class="file-col-size"></div>
        </div>
        <div v-for="file in props.loading ? [] : props.files" :key="file.path" :class="['file-row', 'dialog-file-row', props.selectedFilePaths.includes(file.path) ? 'selected' : '']" role="group" :aria-label="file.name" @mousedown="emit('begin-selection', file.path, $event)" @mouseenter="emit('drag-select', file.path)">
          <label class="file-check" :aria-label="`选择 ${file.name}`" @mousedown.stop @click.stop>
            <input type="checkbox" :checked="props.selectedFilePaths.includes(file.path)" @change="emit('toggle-selected', file.path)" />
            <span aria-hidden="true" />
          </label>
          <button type="button" class="file-col-name file-open" @dblclick.stop="emit('open-entry', file)" @keydown.enter.prevent="emit('open-entry', file)" @keydown.space.prevent="emit('open-entry', file)">
            <span :class="['file-icon', file.type === 'directory' ? 'file-icon-directory' : 'file-icon-file']" aria-hidden="true" />
            <span class="visually-hidden">{{ file.type === "directory" ? "文件夹" : "文件" }}</span>
            <span>{{ file.name }}</span>
          </button>
          <div class="file-col-type">{{ fileType(file) }}</div>
          <div class="file-col-size">{{ file.type === "file" ? props.formatBytes(file.size) : "" }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
