/** Keep keyboard focus inside a settings dialog and restore it on close. */
export function useSettingsDialog(isOpen: () => boolean, isBusy: () => boolean, close: () => void) {
  const dialog = ref<HTMLElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  function focusableElements() {
    return Array.from(dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    ) ?? []).filter((element) => element.getClientRects().length > 0);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!isOpen() || !dialog.value) return;
    const openDialogs = document.querySelectorAll('.settings-dialog');
    if (openDialogs[openDialogs.length - 1] !== dialog.value) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!isBusy()) close();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialog.value.focus();
    } else if (!dialog.value.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  watch(isOpen, async (open) => {
    if (!import.meta.client) return;
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      if (!isOpen()) return;
      document.addEventListener('keydown', handleKeydown, true);
      const input = dialog.value?.querySelector<HTMLElement>('input:not(:disabled), .cm-content[contenteditable="true"]');
      (input ?? focusableElements()[0] ?? dialog.value)?.focus({ preventScroll: true });
    } else {
      document.removeEventListener('keydown', handleKeydown, true);
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.settings-nav-item.active')?.focus({ preventScroll: true });
      previousFocus = null;
    }
  }, { flush: 'post' });

  onBeforeUnmount(() => {
    if (import.meta.client) document.removeEventListener('keydown', handleKeydown, true);
  });

  return dialog;
}
