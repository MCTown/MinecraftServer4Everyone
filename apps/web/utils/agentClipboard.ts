export async function copyAgentText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请手动选择内容复制");
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
  }
}
