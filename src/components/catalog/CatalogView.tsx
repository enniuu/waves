import type { RefObject } from "preact";
import { useRef } from "preact/hooks";
import { IconMagnifyingGlass2 } from "../icons";
import CatalogCanvas, { type CanvasCard } from "./CatalogCanvas.tsx";

interface CatalogViewProps<T> {
  id: string;
  className: string;
  topbarClassName: string;
  searchBarClassName: string;
  searchIconClassName: string;
  inputId: string;
  gridContainerClassName: string;
  gridClassName: string;
  visible: boolean;
  active: boolean;
  searchBarRef: RefObject<HTMLDivElement>;
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  gridVisible: boolean;
  showSkeleton: boolean;
  items: readonly T[];
  getCard: (item: T) => CanvasCard;
  onSelect: (item: T) => void;
  anime?: boolean;
  emptyMessage?: string | null;
  statusMessage?: string | null;
}

export default function CatalogView<T>({
  id,
  className,
  topbarClassName,
  searchBarClassName,
  searchIconClassName,
  inputId,
  gridContainerClassName,
  gridClassName,
  visible,
  active,
  searchBarRef,
  query,
  placeholder,
  onQueryChange,
  gridVisible,
  showSkeleton,
  items,
  getCard,
  onSelect,
  anime = false,
  emptyMessage,
  statusMessage,
}: CatalogViewProps<T>) {
  const opened = useRef(false);
  if (visible) opened.current = true;
  if (!opened.current) return null;

  return (
    <section
      id={id}
      class={`${className}${visible ? " is-visible" : ""}${active ? " is-active" : ""}`}
      aria-hidden={!active}
    >
      <div class={topbarClassName}>
        <div
          class={`search-bar catalog-search-bar ${searchBarClassName}`}
          ref={searchBarRef}
        >
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <IconMagnifyingGlass2 class={searchIconClassName} />
          <input
            type="text"
            id={inputId}
            placeholder={placeholder}
            autocomplete="off"
            value={query}
            onInput={(event) => onQueryChange(event.currentTarget.value)}
          />
        </div>
      </div>

      <div class={gridContainerClassName}>
        <div
          class={gridClassName}
          style={gridVisible || showSkeleton ? "display:block" : "display:none"}
        >
          <CatalogCanvas items={items} getCard={getCard} onSelect={onSelect}
            anime={anime} loading={showSkeleton} active={visible && active && (gridVisible || showSkeleton)} />
        </div>
        {emptyMessage && <p class="no-results">{emptyMessage}</p>}
        {statusMessage && <p class="no-results">{statusMessage}</p>}
      </div>
    </section>
  );
}
