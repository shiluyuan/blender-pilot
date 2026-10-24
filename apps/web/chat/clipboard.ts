/** Clipboard API requires HTTPS; self-hosted HTTP desktops still need Copy. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Use the user-gesture fallback. */
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const node = document.createElement("textarea");
  node.value = text;
  node.style.position = "fixed";
  node.style.opacity = "0";
  document.body.append(node);
  node.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error("浏览器未允许复制，请手动选择文本。");
  } finally {
    node.remove();
    previous?.focus({ preventScroll: true });
  }
}
