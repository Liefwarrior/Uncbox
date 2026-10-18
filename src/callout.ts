import type { BoardId } from './state/model';

/**
 * Points at a panel: rings it for a moment and focuses the control marked data-setup inside it
 * (the Twitch channel box, Start camera…). Waits two frames so a panel added in the same click
 * has rendered first.
 */
export function callOut(id: BoardId) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const cell = document.querySelector<HTMLElement>(`[data-panel="${id}"] .board__inner`);
      if (!cell) return;
      cell.classList.remove('is-called');
      void cell.offsetWidth; // restart the animation if it is already running
      cell.classList.add('is-called');
      cell.addEventListener('animationend', () => cell.classList.remove('is-called'), { once: true });
      cell.querySelector<HTMLElement>('[data-setup]')?.focus({ preventScroll: true });
    }),
  );
}
