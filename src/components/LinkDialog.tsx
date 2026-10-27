import { useState } from "react";

interface Props {
  initialUrl: string;
  onApply: (url: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}

export default function LinkDialog({ initialUrl, onApply, onRemove, onCancel }: Props) {
  const [url, setUrl] = useState(initialUrl);

  const apply = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      onRemove();
      return;
    }
    // Typing "example.com" should make a link, not a relative path that goes nowhere.
    const normalised = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    onApply(normalised);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Link"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Link</h2>
        <input
          className="modal-input"
          value={url}
          placeholder="example.com"
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="modal-actions">
          {initialUrl && (
            <button className="btn" onClick={onRemove}>
              Remove
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
