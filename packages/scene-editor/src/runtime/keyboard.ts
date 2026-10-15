/** Minimal keyboard shape accepted by the headless facade (no DOM types). */
export interface KeyboardLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  preventDefault?: () => void;
}

/** Targets the keyboard may act on; both satisfied by EditorController. */
export interface KeyboardCommandTarget {
  undo(): boolean;
  redo(): boolean;
}

/**
 * Shared key semantics with SceneEditorElement (D20 capture list):
 * - Ctrl/Cmd+Z → undo
 * - Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y → redo
 * - bare G / R / S → reserved tool modes (consumed, no-op)
 * Returns true when the key was consumed (host should not also handle it).
 * Focus-domain checks stay with the DOM owner — this is pure key mapping.
 */
export function handleEditorKeyCommand(target: KeyboardCommandTarget, event: KeyboardLike): boolean {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === "z" && !event.shiftKey) {
    event.preventDefault?.();
    target.undo();
    return true;
  }
  if ((mod && key === "z" && event.shiftKey) || (mod && key === "y")) {
    event.preventDefault?.();
    target.redo();
    return true;
  }
  if (!mod && (key === "g" || key === "r" || key === "s")) {
    event.preventDefault?.();
    return true;
  }
  return false;
}
