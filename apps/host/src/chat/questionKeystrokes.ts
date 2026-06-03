// Encode an AskUserQuestion answer into the exact keystrokes that drive claude's
// interactive terminal question menu. Pure + blind: it assumes the TUI is at rest
// (first question active, cursor on option 1, nothing checked) because the Chat
// tab is the control surface. Probed against claude v2.1.161 — see the
// askuserquestion-tui-keystrokes reference for the protocol this mirrors:
//
//  - options are 1-indexed in input order; after the N real options claude
//    appends `N+1 = "Type something."` (Other) and `N+2 = "Chat about this"`.
//  - single-select: press the option digit. Lone question -> submits instantly;
//    in a multi-question call it selects and auto-advances (the last one lands on
//    a Submit-review screen).
//  - multiSelect: press each option digit to TOGGLE (all start unchecked), then
//    press Right to advance. Enter would toggle the focused row, never submit.
//  - Other: press N+1 to focus "Type something", type the text, press Enter.
//  - "Chat about this": press N+2 on the first question -> declines ALL questions
//    and returns to the composer (the user then types a normal message).
//  - a Submit-review screen appears iff there are >1 questions OR any multiSelect;
//    on it, `1` submits. A lone single-select/Other submits without a review.
import type { QuestionResponse } from "@orden/chat-core";

// The shape of each question the encoder needs — derived by the host from the
// transcript (authoritative), not trusted from the client.
export interface QuestionSpec {
  optionCount: number;
  multiSelect: boolean;
}

// A single send-keys op: a literal string (typed verbatim) or a named key.
export type KeyOp =
  | { type: "literal"; value: string }
  | { type: "key"; name: "Enter" | "Right" };

const lit = (value: string): KeyOp => ({ type: "literal", value });
const key = (name: "Enter" | "Right"): KeyOp => ({ type: "key", name });

// claude's menu maps options to single number keys. The AskUserQuestion schema
// caps options at 4, so the highest digit we ever need is N+2 = 6 — but guard
// anyway so a malformed question fails loud instead of typing a stray "1" + "0".
function digit(n: number): KeyOp {
  if (n < 1 || n > 9) {
    throw new Error(`questionKeystrokes: option digit ${n} out of range (1-9)`);
  }
  return lit(String(n));
}

export function encodeQuestionKeystrokes(
  questions: QuestionSpec[],
  response: QuestionResponse,
): KeyOp[] {
  if (questions.length === 0) throw new Error("questionKeystrokes: no questions");

  // "Chat about this": the decline entry is N+2 on the first question. Pressing
  // it declines the whole call; the user then types their reply in the composer.
  if (response.kind === "chat") {
    return [digit(questions[0].optionCount + 2)];
  }

  const { answers } = response;
  if (answers.length !== questions.length) {
    throw new Error(
      `questionKeystrokes: ${answers.length} answers for ${questions.length} questions`,
    );
  }

  const ops: KeyOp[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    switch (a.kind) {
      case "option":
        // Selects and auto-advances (or lands on the review screen if last).
        ops.push(digit(a.index + 1));
        break;
      case "multi":
        // Toggle each chosen option, then Right to advance — never Enter.
        for (const idx of a.indexes) ops.push(digit(idx + 1));
        ops.push(key("Right"));
        break;
      case "other":
        // Focus "Type something" (N+1), type the text, Enter to confirm.
        ops.push(digit(q.optionCount + 1));
        ops.push(lit(a.text));
        ops.push(key("Enter"));
        break;
    }
  }

  // The review screen appears for multi-question calls or whenever a multiSelect
  // is present; a lone single-select/Other already submitted above.
  const reviewAppears = questions.length > 1 || questions.some((q) => q.multiSelect);
  if (reviewAppears) ops.push(digit(1)); // "1. Submit answers"

  return ops;
}
