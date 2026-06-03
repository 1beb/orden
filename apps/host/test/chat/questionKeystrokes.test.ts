import { describe, it, expect } from "vitest";
import {
  encodeQuestionKeystrokes,
  type KeyOp,
  type QuestionSpec,
} from "../../src/chat/questionKeystrokes";

// Compact the op list to a readable string so expectations are easy to scan:
// a literal as-is, a named key as <Name>.
function seq(ops: KeyOp[]): string {
  return ops.map((o) => (o.type === "literal" ? o.value : `<${o.name}>`)).join("");
}

const single = (n: number): QuestionSpec => ({ optionCount: n, multiSelect: false });
const multi = (n: number): QuestionSpec => ({ optionCount: n, multiSelect: true });

describe("encodeQuestionKeystrokes", () => {
  it("lone single-select: just the option digit, no submit", () => {
    // 3 options, pick the 2nd (Green) — press '2', submits instantly.
    const ops = encodeQuestionKeystrokes([single(3)], {
      kind: "submit",
      answers: [{ kind: "option", index: 1 }],
    });
    expect(seq(ops)).toBe("2");
  });

  it("two single-selects: digit each, then review submit", () => {
    // Q1 pick option 1 (auto-advances), Q2 pick option 2 (advances to review), '1' submits.
    const ops = encodeQuestionKeystrokes([single(2), single(2)], {
      kind: "submit",
      answers: [
        { kind: "option", index: 0 },
        { kind: "option", index: 1 },
      ],
    });
    expect(seq(ops)).toBe("12" + "1");
  });

  it("lone multiSelect: toggle each, Right, then review submit", () => {
    // 3 options, check 1st and 3rd: toggle '1','3', Right to review, '1' submits.
    const ops = encodeQuestionKeystrokes([multi(3)], {
      kind: "submit",
      answers: [{ kind: "multi", indexes: [0, 2] }],
    });
    expect(seq(ops)).toBe("13" + "<Right>" + "1");
  });

  it("single-select then multiSelect: advance correctly into review", () => {
    const ops = encodeQuestionKeystrokes([single(2), multi(3)], {
      kind: "submit",
      answers: [
        { kind: "option", index: 0 }, // '1' advances to Q2
        { kind: "multi", indexes: [0, 1] }, // toggle '1','2', Right to review
      ],
    });
    expect(seq(ops)).toBe("1" + "12" + "<Right>" + "1");
  });

  it("lone Other: focus N+1, type text, Enter — no review submit", () => {
    // 2 real options -> "Type something" is option 3. Focus '3', type, Enter.
    const ops = encodeQuestionKeystrokes([single(2)], {
      kind: "submit",
      answers: [{ kind: "other", text: "kiwi" }],
    });
    expect(seq(ops)).toBe("3" + "kiwi" + "<Enter>");
  });

  it("Other inside a multi-question call ends on the review submit", () => {
    const ops = encodeQuestionKeystrokes([single(2), single(2)], {
      kind: "submit",
      answers: [
        { kind: "other", text: "custom" }, // '3' focus, type, Enter (advances)
        { kind: "option", index: 1 }, // '2' advances to review
      ],
    });
    expect(seq(ops)).toBe("3custom<Enter>" + "2" + "1");
  });

  it("chat: declines via the N+2 entry on the first question", () => {
    // 4 options -> "Chat about this" is option 6.
    const ops = encodeQuestionKeystrokes([single(4), single(2)], { kind: "chat" });
    expect(seq(ops)).toBe("6");
  });

  it("rejects an answer count that doesn't match the questions", () => {
    expect(() =>
      encodeQuestionKeystrokes([single(2), single(2)], {
        kind: "submit",
        answers: [{ kind: "option", index: 0 }],
      }),
    ).toThrow(/answers for/);
  });

  it("rejects an out-of-range option digit", () => {
    expect(() =>
      encodeQuestionKeystrokes([single(10)], {
        kind: "submit",
        answers: [{ kind: "option", index: 9 }], // digit 10
      }),
    ).toThrow(/out of range/);
  });

  it("throws on no questions", () => {
    expect(() => encodeQuestionKeystrokes([], { kind: "chat" })).toThrow(/no questions/);
  });
});
