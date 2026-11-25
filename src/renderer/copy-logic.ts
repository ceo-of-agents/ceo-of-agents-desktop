// Copy buttons in the chat.

/** How long the button shows its confirmation before it goes back to the copy icon. */
export const COPIED_MS = 1500;

/** The code of a rendered block: its text without the single newline the Markdown parser leaves at the end. */
export function codeBlockText(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Writes plain text to the clipboard; true when it worked, false when the write was refused or there is no clipboard. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
