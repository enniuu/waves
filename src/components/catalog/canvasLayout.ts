export function canvasLayout(width: number, count: number, anime: boolean) {
  const gap = anime ? 12 : 8;
  const columns = Math.max(1, Math.floor((width + gap) / ((anime ? 150 : 130) + gap)));
  const cardWidth = (width - (columns - 1) * gap) / columns;
  const cardHeight = anime ? cardWidth * 1.5 : Math.max(70, cardWidth * 1.05);
  const stride = cardHeight + gap;
  return { columns, cardWidth, cardHeight, gap, stride,
    height: Math.max(0, Math.ceil(count / columns) * stride - gap) };
}

export function canvasHit(layout: ReturnType<typeof canvasLayout>, count: number, x: number, y: number) {
  if (x < 0 || y < 0) return -1;
  const column = Math.floor(x / (layout.cardWidth + layout.gap));
  const row = Math.floor(y / layout.stride);
  const index = row * layout.columns + column;
  return column < layout.columns && index < count &&
    x - column * (layout.cardWidth + layout.gap) < layout.cardWidth &&
    y - row * layout.stride < layout.cardHeight ? index : -1;
}

export function canvasWindow(layout: ReturnType<typeof canvasLayout>, top: number, viewportHeight: number) {
  const offset = Math.min(layout.height, Math.max(0, Math.floor(top / layout.stride) - 1) * layout.stride);
  return { offset, height: Math.min(layout.height - offset, viewportHeight + 2 * layout.stride) };
}
