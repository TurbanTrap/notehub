import { useState } from "react";
import { clampWidth, type PaneRange } from "../lib/panes";

interface Props {
  /** Which side of the line the pane being resized sits on. */
  side: "left" | "right";
  width: number;
  range: PaneRange;
  label: string;
  /** Called on every pointer move, so the pane follows the cursor. */
  onWidth: (width: number) => void;
  /** Called once the drag ends — the moment worth writing to storage. */
  onSettled: (width: number) => void;
}

/**
 * The line between two panes, dragged to resize.
 *
 * It is wider than it looks. The rule on screen is one pixel, but a one-pixel target is
 * a miserable thing to aim at, so the grab area is nine and straddles the border.
 */
export default function PaneDivider({ side, width, range, label, onWidth, onSettled }: Props) {
  const [dragging, setDragging] = useState(false);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Without this the drag selects text in whichever pane it passes over.
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = width;
    // The last width is kept here rather than read from the prop at the end: the prop
    // belongs to the render that began the drag and never updates inside these handlers.
    let latest = startWidth;
    setDragging(true);

    const move = (e: PointerEvent) => {
      // Dragging away from the pane's own edge makes it wider, whichever side it is on.
      const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
      latest = clampWidth(startWidth + delta, range);
      onWidth(latest);
    };

    // Listening on the window, not the divider, so the pane keeps following a cursor
    // that has run ahead of it — which it will, at the ends of the range.
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setDragging(false);
      onSettled(latest);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const nudge = (event: React.KeyboardEvent) => {
    const towards = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!towards) return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 12;
    const next = clampWidth(width + towards * step * (side === "left" ? 1 : -1), range);
    onWidth(next);
    onSettled(next);
  };

  const reset = () => {
    onWidth(range.fallback);
    onSettled(range.fallback);
  };

  return (
    <div
      className={`pane-divider pane-divider-${side}${dragging ? " pane-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={startDrag}
      onKeyDown={nudge}
      onDoubleClick={reset}
    />
  );
}
