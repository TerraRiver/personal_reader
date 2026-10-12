export const isMac = navigator.userAgent.includes('Mac');

/** The platform's primary shortcut modifier is held: ⌘ on macOS, Ctrl elsewhere. */
export const isMod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

/** Shortcut label for tooltips, e.g. "⌘B" or "Ctrl+B". */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
