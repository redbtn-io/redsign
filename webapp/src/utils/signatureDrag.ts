export type DragPosition = {
  x: number;
  y: number;
};

export function shouldOpenSignatureModal(
  start: DragPosition,
  end: DragPosition,
  threshold = 0.1,
): boolean {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  return dx < threshold && dy < threshold;
}

