<script setup lang="ts">
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";

const props = withDefaults(defineProps<{
  modelValue?: string;
  readonly?: boolean;
  placeholder?: string;
}>(), {
  modelValue: "",
  readonly: false,
  placeholder: ""
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

function createState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      markdown(),
      oneDark,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.editable.of(!props.readonly),
      EditorState.readOnly.of(props.readonly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
        }
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "0.82rem",
          backgroundColor: "transparent"
        },
        ".cm-scroller": {
          fontFamily: 'Consolas, "Cascadia Mono", "SF Mono", Menlo, monospace',
          lineHeight: "1.55",
          overflow: "auto"
        },
        ".cm-content": {
          padding: "0.65rem 0",
          caretColor: "#e5a900"
        },
        ".cm-gutters": {
          backgroundColor: "rgba(0, 0, 0, 0.22)",
          borderRight: "1px solid rgba(229, 169, 0, 0.16)",
          color: "rgba(255, 255, 255, 0.38)"
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(229, 169, 0, 0.06)"
        },
        ".cm-activeLineGutter": {
          backgroundColor: "rgba(229, 169, 0, 0.1)"
        },
        "&.cm-focused": {
          outline: "none"
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "rgba(229, 169, 0, 0.28) !important"
        }
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
  if (!view || !host.value) return;
  const doc = view.state.doc.toString();
  view.destroy();
  view = new EditorView({
    state: createState(doc),
    parent: host.value
  });
});

function focus() {
  view?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div ref="host" class="cm-host" />
</template>
