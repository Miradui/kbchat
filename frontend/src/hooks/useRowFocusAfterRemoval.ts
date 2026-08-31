import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeps keyboard focus in a list after a row is deleted.
 *
 * Deleting a row unmounts the control that started the delete, so there is nothing for
 * the confirm dialog to return focus to. `useModalFocus` falls back to a page-level
 * target, which beats `body` but throws the user out of the list they were working in.
 * This puts focus on the same control in the neighbouring row instead.
 *
 * Two pieces of ordering make this work, and both are the reason it is a hook rather
 * than a line in a click handler:
 *
 * - The neighbour is chosen when the delete is *started*, while every row is still
 *   mounted. Afterwards the deleted row has deregistered and its position is unknown.
 * - Focus is applied in an effect, not in the handler. The closing dialog restores focus
 *   during its own cleanup, so anything done in the handler is immediately overridden.
 */
export function useRowFocusAfterRemoval<Id extends string>(removedId: Id | null) {
  /* Insertion-ordered, and rows register during render, so iteration order matches the
     screen. Deregistering on unmount is load-bearing, not just tidiness: `set` on a key
     that is already present keeps its original position, so re-registering never
     reorders anything, and an entry left behind by a deleted row stays wedged between
     its neighbours where the next delete will pick it. */
  const rows = useRef(new Map<Id, HTMLElement>());
  const pending = useRef<HTMLElement | null>(null);

  const rowRef = useCallback((id: Id) => (element: HTMLElement | null) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  }, []);

  /**
   * Call when a delete is initiated, before the row goes away: picks the row after `id`,
   * or the one before it when `id` is last. A single-row list has no neighbour, so focus
   * is left to the dialog's own fallback -- there is no list left to stay inside.
   */
  const rememberNeighbour = useCallback((id: Id) => {
    const ids = [...rows.current.keys()];
    const index = ids.indexOf(id);
    if (index === -1) return;
    const neighbour = ids[index + 1] ?? ids[index - 1];
    pending.current = neighbour === undefined ? null : rows.current.get(neighbour) ?? null;
  }, []);

  /*
    Keyed on `removedId` so one delete moves focus once. Being a passive effect is the
    whole point: the closing dialog restores focus in its own cleanup, and React runs
    every cleanup before every effect, so this lands afterwards and wins.

    No `isConnected` test on the target, and no guard on `removedId` being set: focusing
    a detached node is a no-op rather than an error, so a neighbour that a refetch
    replaced just leaves the dialog's own fallback in place, and on mount there is no
    remembered neighbour to act on.

    Clearing `pending` is about not holding a detached row alive, not about focus -- every
    caller sets it again before the next `removedId`, so nothing observable depends on it.
  */
  useEffect(() => {
    const target = pending.current;
    pending.current = null;
    if (target) target.focus();
  }, [removedId]);

  return { rowRef, rememberNeighbour };
}
