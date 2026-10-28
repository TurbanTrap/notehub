/**
 * A toolbar button that drops down a grid of colours.
 *
 * Used for both the text colour and the highlighter. The one thing it has to get
 * right is focus: clicking anywhere in here must not take the caret out of the page,
 * or the colour would be applied to nothing. Every press cancels its own default,
 * which is what moves focus.
 */
import { useEffect, useRef } from "react";
import type { Swatch } from "../lib/textStyles";

interface Props {
  /** The letter on the button itself — A for text, a pen for the highlighter. */
  label: string;
  title: string;
  hint?: string;
  swatches: Swatch[];
  /** The colour in force where the caret is, shown as a bar under the label. */
  current: string | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (value: string) => void;
  onClear: () => void;
  clearLabel: string;
}

export default function SwatchMenu({
  label,
  title,
  hint,
  swatches,
  current,
  open,
  onToggle,
  onClose,
  onPick,
  onClear,
  clearLabel,
}: Props) {
  const root = useRef<HTMLDivElement>(null);

  // Close on a press anywhere else, and on Escape. Without the first, the menu
  // stays up while the person carries on typing underneath it.
  useEffect(() => {
    if (!open) return;

    const awayPress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", awayPress, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", awayPress, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, onClose]);

  return (
    <div className="swatch-menu" ref={root}>
      <button
        className={`tb-btn tb-swatch ${open ? "tb-active" : ""}`}
        data-tip={title}
        data-hint={hint ?? ""}
        data-keys=""
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
      >
        <span className="swatch-letter">{label}</span>
        <span
          className="swatch-bar"
          style={current ? { background: current } : undefined}
        />
      </button>

      {open && (
        <div className="swatch-pop" role="menu">
          <div className="swatch-grid">
            {swatches.map((swatch) => (
              <button
                key={swatch.value}
                className={`swatch ${current === swatch.value ? "swatch-on" : ""}`}
                style={{ background: swatch.value }}
                title={swatch.label}
                aria-label={swatch.label}
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(swatch.value);
                  onClose();
                }}
              />
            ))}
          </div>
          <button
            className="swatch-clear"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            {clearLabel}
          </button>
        </div>
      )}
    </div>
  );
}
