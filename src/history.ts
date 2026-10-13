import { api } from './types';

/**
 * Routes undo / redo: a focused text field keeps its own native history;
 * anything else goes to the screen that registered a handler (the reader's
 * annotations).
 */
type Handler = (action: 'undo' | 'redo') => void;
let handler: Handler | null = null;

export function setHistoryHandler(fn: Handler | null) {
  handler = fn;
}

const editing = () => {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
};

export function listenForHistory() {
  return api().onEditHistory((action) => {
    if (editing()) document.execCommand(action);
    else handler?.(action);
  });
}
