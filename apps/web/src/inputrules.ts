import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  type InputRule,
} from "prosemirror-inputrules";
import type { Schema } from "prosemirror-model";

// Markdown-style shortcuts: "## " -> heading, "- " / "1. " -> lists,
// "> " -> blockquote, "```" -> code block. Fired as you type.
export function buildInputRules(schema: Schema) {
  const rules: InputRule[] = [];
  const { blockquote, ordered_list, bullet_list, code_block, heading } = schema.nodes;

  if (heading) {
    rules.push(
      textblockTypeInputRule(/^(#{1,6})\s$/, heading, (match) => ({
        level: match[1].length,
      })),
    );
  }
  if (blockquote) rules.push(wrappingInputRule(/^\s*>\s$/, blockquote));
  if (bullet_list) rules.push(wrappingInputRule(/^\s*([-+*])\s$/, bullet_list));
  if (ordered_list) {
    rules.push(
      wrappingInputRule(
        /^(\d+)\.\s$/,
        ordered_list,
        (match) => ({ order: +match[1] }),
        (match, node) => node.childCount + (node.attrs.order as number) === +match[1],
      ),
    );
  }
  if (code_block) rules.push(textblockTypeInputRule(/^```$/, code_block));

  return inputRules({ rules });
}
