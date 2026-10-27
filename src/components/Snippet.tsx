import { splitSnippet } from "../lib/snippet";

/**
 * A search snippet with its matched words highlighted.
 *
 * The index marks matches with control characters instead of HTML, and these become
 * React elements. Nothing from a note is ever treated as markup, so a page containing
 * `<script>` is shown as the text it is.
 */
export default function Snippet({ text }: { text: string }) {
  return (
    <span className="snippet">
      {splitSnippet(text).map((run, i) =>
        run.match ? <mark key={i}>{run.text}</mark> : <span key={i}>{run.text}</span>,
      )}
    </span>
  );
}
