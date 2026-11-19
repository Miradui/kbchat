import type { KeyboardEvent } from 'react';

const DEFAULT_MENU_SELECTOR = [
  '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
  '[role="menuitemradio"]:not(:disabled):not([aria-disabled="true"])',
  'button:not(:disabled):not([aria-disabled="true"])',
].join(', ');

/** Moves keyboard focus across enabled menu controls with ArrowDown/ArrowUp/Home/End. */
export function moveMenuFocus(
  event: KeyboardEvent<HTMLElement>,
  selector = DEFAULT_MENU_SELECTOR,
): boolean {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;

  // Traverse all descendants in document order because nwsapi (jsdom) does not
  // always preserve DOM order across comma-separated selector lists.
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('*'))
    .filter((element) => element.matches(selector));
  if (controls.length === 0) return false;

  event.preventDefault();
  if (event.key === 'Home') {
    controls[0]?.focus();
    return true;
  }
  if (event.key === 'End') {
    controls.at(-1)?.focus();
    return true;
  }

  const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = currentIndex === -1
    ? (direction === 1 ? 0 : controls.length - 1)
    : (currentIndex + direction + controls.length) % controls.length;
  controls[nextIndex]?.focus();
  return true;
}
