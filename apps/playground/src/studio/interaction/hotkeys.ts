export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Declarative single-key shortcuts.
 *
 * Modifier combos are intentionally not bound here: Ctrl/Cmd+Z is owned by the
 * element's capture list (D20) and would otherwise fire twice when focus is
 * inside the viewport.
 */
export function bindHotkeys(map: HotkeyMap, target: Window = window): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const element = event.target as HTMLElement | null;
    if (element && (EDITABLE_TAGS.has(element.tagName) || element.isContentEditable)) {
      return;
    }

    const key = event.key === " " ? "space" : event.key.toLowerCase();
    const run = map[key];
    if (!run) return;

    event.preventDefault();
    run(event);
  };

  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
