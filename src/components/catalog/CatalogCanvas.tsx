import { useLayoutEffect, useRef } from "preact/hooks";
import { getDefaultScrollTarget } from "../../core/ui/dom.ts";
import { canvasHit, canvasLayout, canvasWindow } from "./canvasLayout.ts";

export interface CanvasCard {
  title: string;
  cover?: string | null | undefined;
  smallCover?: string | null | undefined;
  year?: number | undefined;
  rating?: number | undefined;
  adult?: boolean | undefined;
}

interface Props<T> {
  items: readonly T[];
  getCard: (item: T) => CanvasCard;
  onSelect: (item: T) => void;
  anime: boolean;
  loading: boolean;
  active: boolean;
}

const MISSING_IMAGE_PATH_DATA =
  "M18.25 3C19.7688 3 21 4.23122 21 5.75V18.25C21 19.7688 19.7688 21 18.25 21H5.75C4.23122 21 3 19.7688 3 18.25V5.75C3 4.23122 4.23122 3 5.75 3H18.25ZM9.2373 13.2373C8.55392 12.5541 7.44608 12.5541 6.7627 13.2373L4.5 15.5V18.25C4.5 18.9404 5.05964 19.5 5.75 19.5H15.5L9.2373 13.2373ZM15 6.5C13.6193 6.5 12.5 7.61929 12.5 9C12.5 10.3807 13.6193 11.5 15 11.5C16.3807 11.5 17.5 10.3807 17.5 9C17.5 7.61929 16.3807 6.5 15 6.5Z";

export default function CatalogCanvas<T>({ items, getCard, onSelect, anime, loading, active }: Props<T>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const selectionRef = useRef(onSelect);
  selectionRef.current = onSelect;

  useLayoutEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!host || !canvas || !ctx) return;
    const missingImagePath = new Path2D(MISSING_IMAGE_PATH_DATA);
    const scroll = getDefaultScrollTarget();
    const count = loading ? 18 : items.length;
    const images = imagesRef.current;
    const loadedAt = new WeakMap<HTMLImageElement, number>();
    const cards = new Map<number, {
      card: CanvasCard;
      lines?: string[];
      yearWidth?: number;
      ratingWidth?: number;
      painted?: { amount: number; opacity: number; ready: boolean };
    }>();
    const transitions = new Map<number, { from: number; to: number; start: number }>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    const lowBandwidth = connection?.saveData || /^(slow-2g|2g|3g)$/.test(connection?.effectiveType || "");
    let layoutWidth = host.clientWidth;
    let layout = canvasLayout(layoutWidth, count, anime);
    let offset = 0;
    let frame = 0;
    let hovered = -1;
    let disposed = false;
    let fullRedraw = true;
    let styleDirty = true;
    let fontFamily = "";
    const colors = new Map<string, string>();
    const color = (name: string, fallback: string) => colors.get(name) || fallback;

    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    };
    const cssEase = (t: number) => {
      let u = t;
      for (let i = 0; i < 5; i++) {
        const v = 1 - u;
        const x = 3 * v * v * u * 0.25 + 3 * v * u * u * 0.25 + u * u * u;
        const dx = 0.75 * v * v + 2.25 * u * u;
        if (Math.abs(dx) < 1e-6) break;
        u = Math.max(0, Math.min(1, u - (x - t) / dx));
      }
      const v = 1 - u;
      return 3 * v * v * u * 0.1 + 3 * v * u * u + u * u * u;
    };
    const progress = (index: number, now: number, duration: number) => {
      const transition = transitions.get(index);
      if (!transition) return index === hovered ? 1 : 0;
      const t = reducedMotion.matches ? 1 : Math.min(1, (now - transition.start) / duration);
      return transition.from + (transition.to - transition.from) * cssEase(t);
    };
    const hover = (next: number) => {
      if (next === hovered) return;
      const now = performance.now();
      for (const index of [hovered, next]) {
        if (index >= 0) transitions.set(index, {
          from: progress(index, now, 100), to: index === next ? 1 : 0, start: now,
        });
      }
      hovered = next;
      schedule();
    };
    const cover = (card: CanvasCard, url: string) => {
      let image = images.get(url);
      if (!image) {
        image = new Image();
        image.decoding = "async";
      }
      if (!image.onload && (!image.complete || !image.src)) {
        image.onload = () => { loadedAt.set(image!, performance.now()); schedule(); };
        image.onerror = () => {
          if (card.cover && url !== card.cover && image!.src !== card.cover) {
            image!.onerror = schedule;
            image!.src = card.cover;
          } else {
            image!.onerror = null;
            schedule();
          }
        };
      }
      if (!image.src) image.src = url;
      images.delete(url);
      images.set(url, image);
      return image;
    };
    function draw() {
      frame = 0;
      if (!host || !canvas || !ctx) return;
      const width = host.clientWidth;
      if (!width) return;
      if (width !== layoutWidth) {
        layoutWidth = width;
        layout = canvasLayout(width, count, anime);
        cards.clear();
        fullRedraw = true;
      }
      if (host.style.height !== `${layout.height}px`) host.style.height = `${layout.height}px`;
      const viewport = scroll instanceof HTMLElement
        ? { top: scroll.getBoundingClientRect().top, height: scroll.clientHeight }
        : { top: 0, height: window.innerHeight };
      const hostTop = host.getBoundingClientRect().top;
      const { offset: nextOffset, height } = canvasWindow(layout, viewport.top - hostTop, viewport.height);
      if (nextOffset !== offset) fullRedraw = true;
      offset = nextOffset;
      if (canvas.style.top !== `${offset}px`) canvas.style.top = `${offset}px`;
      if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
      const dpr = window.devicePixelRatio || 1;
      const bitmapWidth = Math.ceil(width * dpr);
      const bitmapHeight = Math.ceil(height * dpr);
      if (canvas.width !== bitmapWidth) { canvas.width = bitmapWidth; fullRedraw = true; }
      if (canvas.height !== bitmapHeight) { canvas.height = bitmapHeight; fullRedraw = true; }
      if (!height) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (styleDirty) {
        const style = getComputedStyle(canvas);
        fontFamily = style.fontFamily;
        for (const name of ["--game-card-bg", "--skeleton-alt-from", "--skeleton-alt-via",
          "--game-cover-brightness", "--game-no-cover-line", "--game-card-overlay",
          "--game-info-text", "--color-green", "--color-yellow", "--color-red"]) {
          colors.set(name, style.getPropertyValue(name).trim());
        }
        cards.clear();
        styleDirty = false;
        fullRedraw = true;
      }
      if (fullRedraw) ctx.clearRect(0, 0, width, height);
      const now = performance.now();
      let animating = false;
      const start = Math.floor(offset / layout.stride) * layout.columns;
      const end = Math.min(count, Math.ceil((offset + height) / layout.stride) * layout.columns);
      const used = new Set<string>();
      for (let index = start; index < end; index++) {
        const amount = progress(index, now, 100);
        const transition = transitions.get(index);
        if (transition) {
          if (!reducedMotion.matches && now - transition.start < 100) animating = true;
          else transitions.delete(index);
        }
        const x = (index % layout.columns) * (layout.cardWidth + layout.gap);
        const y = Math.floor(index / layout.columns) * layout.stride - offset;
        const w = layout.cardWidth;
        const h = layout.cardHeight;
        let entry = cards.get(index);
        if (!loading && !entry) {
          entry = { card: getCard(items[index]!) };
          cards.set(index, entry);
        }
        const card = entry?.card;
        const url = card && (lowBandwidth && card.smallCover ? card.smallCover : card.cover);
        if (url) used.add(url);
        const image = card && url ? cover(card, url) : undefined;
        const ready = !!(image?.complete && image.naturalWidth);
        const opacity = ready && !reducedMotion.matches
          ? cssEase(Math.min(1, (now - (loadedAt.get(image!) ?? now - 100)) / 100)) : 1;
        if (opacity < 1) animating = true;
        const previous = entry?.painted;
        if (!fullRedraw && !loading && previous?.amount === amount &&
          previous.opacity === opacity && previous.ready === ready) continue;
        if (entry) entry.painted = { amount, opacity, ready };
        if (!fullRedraw) ctx.clearRect(x, y, w, h);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 10);
        ctx.clip();
        ctx.fillStyle = color("--game-card-bg", "#222");
        ctx.fillRect(x, y, w, h);
        if (loading) {
          ctx.fillStyle = color("--skeleton-alt-from", "#333");
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = color("--skeleton-alt-via", "#555");
          ctx.fillRect(x + 8, y + h - 22, w * 0.65, 8);
          if (!reducedMotion.matches) {
            const left = x + ((now % 1000) / 1000 * 2 - 1) * w;
            const shimmer = ctx.createLinearGradient(left, 0, left + w, 0);
            shimmer.addColorStop(0, "transparent");
            shimmer.addColorStop(0.5, color("--skeleton-alt-via", "#555"));
            shimmer.addColorStop(1, "transparent");
            ctx.fillStyle = shimmer;
            ctx.fillRect(x, y, w, h);
            animating = true;
          }
        } else if (card && entry) {
          if (ready && image) {
            ctx.globalAlpha = opacity;
            const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight) * (1 + 0.05 * amount);
            ctx.drawImage(image, x + (w - image.naturalWidth * scale) / 2,
              y + (h - image.naturalHeight * scale) / 2,
              image.naturalWidth * scale, image.naturalHeight * scale);
            const brightness = Number(color("--game-cover-brightness", "1"));
            ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 1 - brightness) * (1 - amount)})`;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
          } else {
            const iconSize = Math.min(36, w * 0.3, h * 0.2);
            ctx.save();
            ctx.translate(x + w / 2 - iconSize / 2, y + h / 2 - iconSize / 2);
            ctx.scale(iconSize / 24, iconSize / 24);
            ctx.fillStyle = color("--game-no-cover-line", "#888");
            ctx.fill(missingImagePath, "evenodd");
            ctx.restore();
          }
          const gradient = ctx.createLinearGradient(0, y + h * 0.6, 0, y + h);
          gradient.addColorStop(0, "transparent");
          gradient.addColorStop(1, "rgba(0,0,0,0.85)");
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, w, h);
          if (amount > 0) {
            ctx.globalAlpha = amount;
            ctx.fillStyle = color("--game-card-overlay", "transparent");
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
          }
          ctx.font = `300 10px ${fontFamily}`;
          ctx.textBaseline = "top";
          if (!entry.lines) {
            entry.lines = [];
            let line = "";
            for (const word of card.title.toLowerCase().trim().split(/\s+/)) {
              const next = line ? `${line} ${word}` : word;
              if (line && ctx.measureText(next).width > w - 16) {
                entry.lines.push(line);
                line = word;
              } else line = next;
            }
            entry.lines.push(line);
          }
          const lines = entry.lines;
          const hasMeta = anime && (card.year || card.rating || card.adult);
          ctx.fillStyle = color("--game-info-text", "#f3f3f3");
          lines.forEach((text, row) => ctx.fillText(text, x + 8,
            y + h - 8 - (hasMeta ? 16 : 0) - (lines.length - row) * 14 + 2));
          if (hasMeta) {
            let left = x + 8;
            ctx.font = `400 10px ${fontFamily}`;
            if (card.year) {
              const year = String(card.year);
              ctx.fillText(year, left, y + h - 18);
              left += (entry.yearWidth ??= ctx.measureText(year).width) + 6;
            }
            if (card.rating) {
              const rating = `★ ${card.rating}`;
              ctx.fillStyle = color(card.rating >= 8 ? "--color-green" : card.rating >= 6 ? "--color-yellow" : "--color-red", "#fff");
              ctx.fillText(rating, left, y + h - 18);
              left += (entry.ratingWidth ??= ctx.measureText(rating).width) + 6;
            }
            if (card.adult) {
              ctx.fillStyle = "rgba(239,68,68,0.85)";
              ctx.fillRect(left, y + h - 20, 25, 14);
              ctx.fillStyle = "#fff";
              ctx.fillText("18+", left + 3, y + h - 18);
            }
          }
        }
        ctx.restore();
      }
      fullRedraw = false;
      for (const index of cards.keys()) {
        if (index < start || index >= end) cards.delete(index);
      }
      for (const index of transitions.keys()) {
        if (index < start || index >= end) transitions.delete(index);
      }
      if (animating) schedule();
      for (const [url, image] of images) {
        if (images.size <= Math.max(128, used.size)) break;
        if (!used.has(url)) {
          image.onload = image.onerror = null;
          images.delete(url);
        }
      }
    }
    const hit = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return loading ? -1 : canvasHit(layout, count, event.clientX - rect.left, event.clientY - rect.top + offset);
    };
    const move = (event: MouseEvent) => {
      const next = hit(event);
      hover(next);
      canvas.style.cursor = next < 0 ? "default" : "pointer";
    };
    const leave = () => hover(-1);
    const click = (event: MouseEvent) => {
      const index = hit(event);
      if (index >= 0) selectionRef.current(items[index]!);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    const invalidateStyle = () => { styleDirty = true; schedule(); };
    const theme = new MutationObserver(invalidateStyle);
    for (const node of [document.documentElement, document.body]) {
      theme.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.fonts.addEventListener("loadingdone", invalidateStyle);
    reducedMotion.addEventListener("change", invalidateStyle);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseleave", leave);
    canvas.addEventListener("click", click);
    host.style.height = `${layout.height}px`;
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", invalidateStyle);
      reducedMotion.removeEventListener("change", invalidateStyle);
      canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("mouseleave", leave);
      canvas.removeEventListener("click", click);
      for (const image of images.values()) image.onload = image.onerror = null;
    };
  }, [items, getCard, anime, loading, active]);

  return <div ref={hostRef} class="catalog-canvas-area">
    <canvas ref={canvasRef} class="catalog-canvas" />
  </div>;
}
