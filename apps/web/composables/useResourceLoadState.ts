import { computed, ref } from "vue";

/** Latest request wins. A refresh keeps existing data; a context change resets it. */
export function useResourceLoadState(initiallyPending = true) {
  const loading = ref(initiallyPending);
  const loaded = ref(false);
  const error = ref("");
  let generation = 0;

  function reset() {
    generation += 1;
    loading.value = true;
    loaded.value = false;
    error.value = "";
  }

  // A live snapshot supersedes an in-flight REST snapshot.
  function acceptSnapshot() {
    generation += 1;
    loaded.value = true;
    loading.value = false;
    error.value = "";
  }

  async function run<T>(fetchData: () => Promise<T>, apply: (data: T) => void) {
    const request = ++generation;
    loading.value = true;
    error.value = "";
    try {
      const data = await fetchData();
      if (request !== generation) return;
      apply(data);
      loaded.value = true;
    } catch (cause) {
      if (request !== generation) return;
      error.value = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  return { loading, loaded, error, initialLoading: computed(() => loading.value && !loaded.value), reset, acceptSnapshot, run };
}
