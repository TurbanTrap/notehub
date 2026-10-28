/**
 * An image in a page: click to select, drag any grip to resize, choose which side the
 * text runs down, one button to remove.
 *
 * TipTap's stock image is a bare `<img>`. It can be selected and deleted with
 * Backspace, but there is nothing on screen that says so, no way to change its size,
 * and no way to put it beside the text rather than above it — which is what a
 * screenshot being explained usually wants.
 */
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Small enough to still be recognisable, and not so small it cannot be grabbed. */
const MIN_SIZE = 40;

/**
 * Which grip is being dragged. The sides change one dimension, so the image can be
 * stretched; a corner changes both at once, freely, with Shift to hold the shape.
 */
type Edge = "left" | "right" | "bottom" | "bottom-left" | "bottom-right";

type Align = "left" | "right" | null;

const WRAPS: { value: Align; label: string; hint: string }[] = [
  { value: null, label: "In line", hint: "Image on a line of its own" },
  { value: "left", label: "Wrap left", hint: "Image on the left, text down the right" },
  { value: "right", label: "Wrap right", hint: "Image on the right, text down the left" },
];

export default function ImageView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) ?? "";
  const width = node.attrs.width as number | null;
  const height = node.attrs.height as number | null;
  const align = (node.attrs.align as Align) ?? null;

  const imageRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);

  const startResize = useCallback(
    (event: React.PointerEvent, edge: Edge) => {
      // Stops the node view's own drag, which would otherwise pick the image up and
      // move it instead of resizing it.
      event.preventDefault();
      event.stopPropagation();

      const image = imageRef.current;
      if (!image) return;

      // The text column is the ceiling for a width: wider than that and the image
      // pushes the words it is explaining off the page. Measured from the editor
      // itself rather than the image's own box, which is only as wide as the image
      // once it is floated to one side.
      const column = image.closest(".ProseMirror");
      const maxWidth = column?.clientWidth ?? image.clientWidth;

      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = image.clientWidth;
      const startHeight = image.clientHeight;
      const shape = startHeight > 0 ? startWidth / startHeight : 1;
      setDragging(true);

      const move = (e: PointerEvent) => {
        // Dragging the left-hand grips outward means moving left, so the sign flips.
        const dx = edge === "left" || edge === "bottom-left" ? startX - e.clientX : e.clientX - startX;
        const dy = e.clientY - startY;
        const corner = edge === "bottom-left" || edge === "bottom-right";

        if (edge === "bottom") {
          updateAttributes({ height: clamp(startHeight + dy, Infinity) });
          return;
        }

        const next = clamp(startWidth + dx, maxWidth);
        if (!corner) {
          updateAttributes({ width: next });
          return;
        }

        // A corner moves both, which is the whole point of having one. Shift holds
        // the proportions, the way every other editor's corner does.
        updateAttributes({
          width: next,
          height: e.shiftKey ? Math.round(next / shape) : clamp(startHeight + dy, Infinity),
        });
      };

      const finish = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
    },
    [updateAttributes],
  );

  useEffect(() => {
    if (!selected) setDragging(false);
  }, [selected]);

  const sized = width !== null || height !== null;

  return (
    <NodeViewWrapper
      className={`image-view ${selected ? "image-selected" : ""} ${dragging ? "image-dragging" : ""}`}
      data-align={align ?? "none"}
      data-drag-handle
    >
      <div className="image-frame">
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          // As a style rather than the width and height attributes, because the
          // stylesheet sets `height: auto` for every image in a page and an attribute
          // would lose to it. The attributes are still what gets saved to the file.
          style={{
            width: width ? `${width}px` : undefined,
            height: height ? `${height}px` : undefined,
          }}
        />

        {selected && (
          <>
            <div className="image-bar">
              {WRAPS.map((wrap) => (
                <button
                  key={wrap.label}
                  className={`image-tool ${align === wrap.value ? "image-tool-on" : ""}`}
                  title={wrap.hint}
                  aria-label={wrap.hint}
                  aria-pressed={align === wrap.value}
                  // Without this the editor takes the selection back before the click
                  // lands, and the button appears to do nothing.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => updateAttributes({ align: wrap.value })}
                >
                  <WrapIcon kind={wrap.value ?? "none"} />
                </button>
              ))}

              {sized && (
                <button
                  className="image-tool image-tool-text"
                  title="Back to the image's own size"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => updateAttributes({ width: null, height: null })}
                >
                  Reset
                </button>
              )}

              <button
                className="image-tool image-tool-remove"
                title="Remove this image from the page"
                aria-label="Remove image"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => deleteNode()}
              >
                ✕
              </button>
            </div>

            <span
              className="image-handle image-handle-left"
              role="separator"
              aria-label="Resize the width"
              onPointerDown={(e) => startResize(e, "left")}
            />
            <span
              className="image-handle image-handle-right"
              role="separator"
              aria-label="Resize the width"
              onPointerDown={(e) => startResize(e, "right")}
            />
            <span
              className="image-handle image-handle-bottom"
              role="separator"
              aria-label="Resize the height"
              onPointerDown={(e) => startResize(e, "bottom")}
            />
            <span
              className="image-handle image-corner image-corner-left"
              role="separator"
              aria-label="Resize both ways — hold Shift to keep the shape"
              onPointerDown={(e) => startResize(e, "bottom-left")}
            />
            <span
              className="image-handle image-corner image-corner-right"
              role="separator"
              aria-label="Resize both ways — hold Shift to keep the shape"
              onPointerDown={(e) => startResize(e, "bottom-right")}
            />
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
}

function clamp(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, MIN_SIZE), max));
}

/** A block for the image and rules for the text, showing where each would sit. */
function WrapIcon({ kind }: { kind: "none" | "left" | "right" }) {
  if (kind === "none") {
    return (
      <svg viewBox="0 0 16 14" width="15" height="13" aria-hidden="true">
        <rect x="2" y="4" width="12" height="6" rx="1" fill="currentColor" />
        <rect x="2" y="0.5" width="12" height="1.5" rx="0.7" fill="currentColor" opacity="0.45" />
        <rect x="2" y="12" width="12" height="1.5" rx="0.7" fill="currentColor" opacity="0.45" />
      </svg>
    );
  }

  const onLeft = kind === "left";
  return (
    <svg viewBox="0 0 16 14" width="15" height="13" aria-hidden="true">
      <rect x={onLeft ? 2 : 9} y="2.5" width="5" height="9" rx="1" fill="currentColor" />
      {[2.5, 5.5, 8.5, 11.5].map((y) => (
        <rect
          key={y}
          x={onLeft ? 8.5 : 2}
          y={y}
          width="5.5"
          height="1.5"
          rx="0.7"
          fill="currentColor"
          opacity="0.45"
        />
      ))}
    </svg>
  );
}
