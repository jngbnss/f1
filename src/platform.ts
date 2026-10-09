/**
 * Device detection for the mobile preset and touch controls. `?touch=1|0`
 * forces either way (testing on desktop, or a tablet with a keyboard).
 */
export function isTouchDevice(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  const forced = new URLSearchParams(search).get('touch');
  if (forced !== null) return forced !== '0' && forced !== 'false';
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && (navigator.maxTouchPoints ?? 0) > 0;
}

/** Phones and small tablets: touch-first and a weaker GPU than a desktop. */
export function isMobile(search?: string): boolean {
  if (!isTouchDevice(search)) return false;
  return Math.min(window.screen.width, window.screen.height) < 900 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
