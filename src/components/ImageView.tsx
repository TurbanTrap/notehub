/**
 * An image in a page: click to select, drag a corner to resize, one button to remove.
 *
 * TipTap's stock image is a bare `<img>`. It can be selected and deleted with
 * Backspace, but there is nothing on screen that says so, and no way at all to
 * change its size — which matters here, because a full-width screenshot pushes the
 * text it is explaining off the screen.
 */
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Small enough to still be recognisable, and not so wide it breaks the column. */
const MIN_WIDTH = 60;

export default function ImageView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) ?? "";
  const width = node.attrs.width as number | null;

  const imageRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);

  // The width the image would take with no width set, which is the ceiling for a
  // resize: letting it grow past the column would push the text out of the page.
  const maxWidth = useRef<number>(0);

  const startResize = useCallback(
    (event: React.PointerEvent, edge: "left" | "right") => {
      event.preventDefault();
      event.stopPropagation();

      const image = imageRef.current;
      const column = image?.parentElement?.parentElement;
      if (!image || !column) return;

      maxWidth.current = column.clientWidth;
      const startX = event.clientX;
      const startWidth = image.clientWidth;
      setDragging(true);

      const move = (e: PointerEvent) => {
        // Dragging the left handle outward means moving left, so the sign flips.
        const delta = edge === "right" ? e.clientX - startX : startX - e.clientX;
        const next = Math.round(
          Math.min(Math.max(startWidth + delta, MIN_WIDTH), maxWidth.current),
        );
        updateAttributes({ width: next });
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

  // Backspace already deletes a selected image, and people reach for it — but the
  // button is what tells them the image is deletable at all.
  useEffect(() => {
    if (!selected) setDragging(false);
  }, [selected]);

  return (
    <NodeViewWrapper
      className={`image-view ${selected ? "image-selected" : ""} ${dragging ? "image-dragging" : ""}`}
      data-drag-handle
    >
      <div className="image-frame">
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          width={width ?? undefined}
          draggable={false}
        />

        {selected && (
          <>
            <button
              className="image-remove"
              title="Remove this image from the page"
              aria-label="Remove image"
              // Without this the editor takes the selection back before the click
              // lands, and the button appears to do nothing.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => deleteNode()}
            >
              ✕
            </button>

            <span
              className="image-handle image-handle-left"
              role="separator"
              aria-label="Resize image"
              onPointerDown={(e) => startResize(e, "left")}
            />
            <span
              className="image-handle image-handle-right"
              role="separator"
              aria-label="Resize image"
              onPointerDown={(e) => startResize(e, "right")}
            />

            {width && (
              <button
                className="image-reset"
                title="Back to the image's own size"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => updateAttributes({ width: null })}
              >
                Reset size
              </button>
            )}
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
}
