import { prefersReducedMotion } from "../config/advancedSettings.ts";

export function attachSearchLight(
  searchBar: HTMLElement,
): (() => void) | undefined {
  if (!searchBar || searchBar.dataset["lightAttached"] === "true") return;

  const lightBg = searchBar.querySelector(".light") as HTMLElement | null;
  const lightBorder = searchBar.querySelector(
    ".light-border",
  ) as HTMLElement | null;
  if (!lightBg || !lightBorder) return;

  searchBar.dataset["lightAttached"] = "true";
  const controller = new AbortController();
  const { signal } = controller;
  const lightSize = 300;

  let targetX: number = 0,
    currentX: number = 0,
    lastX: number = 0,
    velocityX: number = 0;
  let targetY: number = 0,
    currentY: number = 0,
    lastY: number = 0,
    velocityY: number = 0;
  let raf: number | null = null;
  let rect: DOMRect = searchBar.getBoundingClientRect();
  let isHovering: boolean = false;
  let isSettled: boolean = false;
  let targetScale: number = 1;
  let scaleDirty: boolean = false;
  let rectRaf: number | null = null;
  let enterTimer: number | null = null;

  const stopMotion = (): void => {
    if (enterTimer) {
      window.clearTimeout(enterTimer);
      enterTimer = null;
    }
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lightBg.style.opacity = "0";
    lightBorder.style.opacity = "0";
  };

  const onMotionPreferenceUpdated = (): void => {
    if (prefersReducedMotion()) stopMotion();
  };

  const updateRect = (): void => {
    rect = searchBar.getBoundingClientRect();
  };

  const scheduleRectUpdate = (): void => {
    if (!isHovering || rectRaf !== null) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = null;
      if (isHovering) updateRect();
    });
  };

  const setBgPosition = (x: string, y: string): void => {
    searchBar.style.setProperty("--bg-x", x);
    searchBar.style.setProperty("--bg-y", y);
  };

  function animate(): void {
    if (prefersReducedMotion()) {
      stopMotion();
      return;
    }

    const deltaX = targetX - currentX;
    const deltaY = targetY - currentY;

    currentX += deltaX * 0.15;
    currentY += deltaY * 0.15;

    const elasticX = Math.min(Math.max(velocityX * 0.5, -20), 20);
    const elasticY = Math.min(Math.max(velocityY * 0.5, -20), 20);
    velocityX *= 0.85;
    velocityY *= 0.85;

    if (scaleDirty) {
      lightBg!.style.transform = `scale(${targetScale})`;
      scaleDirty = false;
    }

    if (
      Math.abs(deltaX) < 0.1 &&
      Math.abs(deltaY) < 0.1 &&
      Math.abs(elasticX) < 0.1 &&
      Math.abs(elasticY) < 0.1
    ) {
      isSettled = true;
      raf = null;

      const finalBgX = `${targetX}px`;
      const finalBgY = `${targetY}px`;

      setBgPosition(finalBgX, finalBgY);
      return;
    }

    const bgX = `${currentX + elasticX}px`;
    const bgY = `${currentY + elasticY}px`;

    setBgPosition(bgX, bgY);

    raf = requestAnimationFrame(animate);
  }

  searchBar.addEventListener("mouseenter", () => {
    if (prefersReducedMotion()) return;
    isHovering = true;
    updateRect();
    if (raf) cancelAnimationFrame(raf);
    isSettled = false;
    raf = requestAnimationFrame(animate);

    lightBg.style.opacity = "1";
    lightBorder.style.opacity = "1";
    lightBg.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBg.style.filter = "blur(20px)";
    lightBorder.style.filter = "blur(6px)";

    if (enterTimer) window.clearTimeout(enterTimer);
    enterTimer = window.setTimeout(() => {
      enterTimer = null;
      if (!isHovering) return;
      lightBg.style.transform = "scale(1)";
      lightBg.style.filter = "blur(12px)";
      lightBorder.style.transform = "scale(1)";
      lightBorder.style.filter = "blur(4px)";
    }, 300);
  }, { signal });

  searchBar.addEventListener("mouseleave", () => {
    isHovering = false;
    scaleDirty = false;
    if (enterTimer) {
      window.clearTimeout(enterTimer);
      enterTimer = null;
    }
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lightBg.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBg.style.opacity = "0";
    lightBorder.style.opacity = "0";
    lightBg.style.transform = "scale(0.95)";
    lightBorder.style.transform = "scale(0.95)";
    lightBg.style.filter = "blur(30px)";
    lightBorder.style.filter = "blur(12px)";
  }, { signal });

  searchBar.addEventListener("mousemove", (e: MouseEvent) => {
    if (prefersReducedMotion()) return;
    targetX = e.clientX - rect.left - lightSize / 2;
    targetY = e.clientY - rect.top - lightSize / 2;

    velocityX = targetX - lastX;
    velocityY = targetY - lastY;
    lastX = targetX;
    lastY = targetY;

    targetScale = Math.min(
      1.2,
      1.2 + ((e.clientX - rect.left) / rect.width) * 0.4,
    );
    scaleDirty = true;

    if (isSettled && !raf) {
      isSettled = false;
      raf = requestAnimationFrame(animate);
    }
  }, { passive: true, signal });

  window.addEventListener("scroll", scheduleRectUpdate, { passive: true, signal });
  window.addEventListener("resize", scheduleRectUpdate, { passive: true, signal });
  document.addEventListener(
    "motionPreferenceUpdated",
    onMotionPreferenceUpdated,
    { signal },
  );

  return () => {
    controller.abort();
    if (raf) cancelAnimationFrame(raf);
    if (rectRaf) cancelAnimationFrame(rectRaf);
    if (enterTimer) window.clearTimeout(enterTimer);
    delete searchBar.dataset["lightAttached"];
  };
}
