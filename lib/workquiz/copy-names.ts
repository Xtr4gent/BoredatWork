/** The text put on the clipboard for a list of people: "Sam, Casey, Drew". */
export function namesForClipboard(names: string[]) {
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Copies text to the clipboard. Browser only. The clipboard API needs a
 * secure page (https or localhost), so plain-http LAN addresses fall back to
 * the older select-and-copy method. Returns whether the copy worked.
 */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or page not focused: try the fallback.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
