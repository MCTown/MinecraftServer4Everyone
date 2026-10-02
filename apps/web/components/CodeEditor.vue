<script setup lang="ts">
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";

const props = withDefaults(defineProps<{
  modelValue?: string;
  readonly?: boolean;
  placeholder?: string;
  theme?: "dark" | "light";
}>(), {
  modelValue: "",
  readonly: false,
  placeholder: ""
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
const { theme: appTheme } = useTheme();
const currentTheme = computed(() => props.theme ?? appTheme.value);
const themeCompartment = new Compartment();
const editableCompartment = new Compartment();
let view: EditorView | null = null;

function editorTheme() {
  const light = currentTheme.value === "light";
  return [
      light ? syntaxHighlighting(defaultHighlightStyle) : oneDark,
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "0.82rem",
          backgroundColor: "transparent",
          color: light ? "#424a53" : "#c9d1d9"
        },
        ".cm-scroller": {
          fontFamily: 'Consolas, "Cascadia Mono", "SF Mono", Menlo, monospace',
          lineHeight: "1.55",
          overflow: "auto"
        },
        ".cm-content": {
          padding: "0.65rem 0",
          caretColor: light ? "#0969da" : "#58a6ff"
        },
        ".cm-gutters": {
          backgroundColor: light ? "#f6f8fa" : "#161b22",
          borderRight: light ? "1px solid #d0d7de" : "1px solid #30363d",
          color: light ? "#818b98" : "#6e7681"
        },
        ".cm-activeLine": {
          backgroundColor: light ? "#0969da08" : "#58a6ff0a"
        },
        ".cm-activeLineGutter": {
          backgroundColor: light ? "#ddf4ff" : "#1f3b5d"
        },
        "&.cm-focused": {
          outline: "none"
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: light ? "#0969da33 !important" : "#58a6ff3d !important"
        }
      })
  ];
}

function editableExtensions() {
  return [EditorView.editable.of(!props.readonly), EditorState.readOnly.of(props.readonly)];
}

function createState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(),
      foldGutter(), indentOnInput(), bracketMatching(), markdown(),
      themeCompartment.of(editorTheme()),
      editableCompartment.of(editableExtensions()),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
      })
    ]
  });
}

function syncDoc(value: string) {
  if (!view) return;
  const current = view.state.doc.toString();
  if (current === value) return;
  view.dispatch({
    changes: { from: 0, to: current.length, insert: value }
  });
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: createState(props.modelValue),
    parent: host.value
  });
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

watch(() => props.modelValue, (value) => {
  syncDoc(value ?? "");
});

watch(() => props.readonly, () => {
  view?.dispatch({ effects: editableCompartment.reconfigure(editableExtensions()) });
});

// Reconfigure in place so switching themes keeps edits, selection and undo history.
watch(currentTheme, () => {
  view?.dispatch({ effects: themeCompartment.reconfigure(editorTheme()) });
});

function focus() {
  view?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div ref="host" class="cm-host" />
</template>
