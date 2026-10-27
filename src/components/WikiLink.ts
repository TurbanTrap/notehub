import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";

/**
 * `[[Another Page]]` — a link from one note to another.
 *
 * An atom, so the editor treats the whole link as one unit: the caret steps over it
 * instead of landing between the brackets, and backspace removes the link rather than
 * leaving `[[Another Pag` behind.
 */
export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-wikilink") ?? "",
        renderHTML: (attributes) => ({ "data-wikilink": attributes.target as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "wikilink" }),
      node.attrs.target as string,
    ];
  },

  renderText({ node }) {
    return `[[${node.attrs.target as string}]]`;
  },

  addInputRules() {
    return [
      nodeInputRule({
        // Fires on the closing bracket, so the link forms as it is typed.
        find: /\[\[([^\]\n]+)\]\]$/,
        type: this.type,
        getAttributes: (match) => ({ target: match[1].trim() }),
      }),
    ];
  },
});
