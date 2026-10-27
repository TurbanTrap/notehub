import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Version } from "../lib/api";

interface Props {
  vaultPath: string;
  pagePath: string;
  onRestore: (stamp: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * Earlier text this page has had, and a way back to it.
 *
 * Snapshots are kept on this machine, outside the notes folder, so they are here even
 * when the note itself has been replaced by a copy from another machine.
 */
export default function HistoryDialog({
  vaultPath,
  pagePath,
  onRestore,
  onClose,
  onError,
}: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .pageVersions(vaultPath, pagePath)
      .then((found) => {
        if (cancelled) return;
        setVersions(found);
        setChosen(found[0]?.stamp ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setVersions([]);
        onError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // onError is a setter from the page above and changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, pagePath]);

  useEffect(() => {
    if (!chosen) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    api
      .readVersion(vaultPath, pagePath, chosen)
      .then((text) => {
        if (!cancelled) setPreview(text);
      })
      .catch((e) => {
        if (!cancelled) onError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, pagePath, chosen]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Earlier versions"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Earlier versions</h2>

        {versions === null ? (
          <p className="modal-note">Looking…</p>
        ) : versions.length === 0 ? (
          <p className="modal-note">
            Nothing kept for this page yet. A copy of the text is put aside every few
            minutes while you work on it, and whenever a version arrives from another
            machine.
          </p>
        ) : (
          <div className="history">
            <ul className="history-list">
              {versions.map((version) => (
                <li key={version.stamp}>
                  <button
                    className={`history-item ${chosen === version.stamp ? "history-current" : ""}`}
                    onClick={() => setChosen(version.stamp)}
                  >
                    <span className="history-when">{when(version.saved)}</span>
                    <span className="history-size">{size(version.bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="history-preview">
              {preview === null ? (
                <p className="modal-note">Loading…</p>
              ) : preview.trim() === "" ? (
                <p className="modal-note">This version was empty.</p>
              ) : (
                // The Markdown as it was, not a rendering of it: this is for deciding
                // whether it is the version you want, and the source is unambiguous.
                <pre>{preview}</pre>
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          {versions && versions.length > 0 && (
            <span className="modal-note">
              Restoring replaces the text only — the title and tags stay as they are,
              and the version you are on now is kept.
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {chosen && (
            <button className="btn btn-primary" onClick={() => onRestore(chosen)}>
              Restore this version
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Local time, since the person is deciding "was this before or after lunch". */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} kB`;
}
