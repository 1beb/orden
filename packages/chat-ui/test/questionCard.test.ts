import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatHarness, ChatMessage, ModelOption, SlashCommand } from "@orden/chat-core";
import { createChatStore } from "../src/chatStore";
import type { ChatClient } from "../src/client";
import { mountChatView } from "../src/chatView";

const SID = "sess-1";
const HARNESS: ChatHarness = "claude";
const md = (t: string) => document.createTextNode(t);

function makeClient(over: Partial<ChatClient> = {}): ChatClient {
  return {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(),
    getMessages: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    respondPermission: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    listModels: vi.fn(async (): Promise<ModelOption[]> => []),
    listCommands: vi.fn(async (): Promise<SlashCommand[]> => []),
    ...over,
  } as ChatClient;
}

// One assistant message carrying an AskUserQuestion tool part.
function questionMsg(questions: unknown[], state: "running" | "done" = "running"): ChatMessage {
  return {
    id: "m",
    role: "assistant",
    parts: [
      { type: "tool", toolId: "t1", name: "AskUserQuestion", input: { questions }, state },
    ],
  };
}

const colorQ = {
  header: "Color",
  question: "Pick a color",
  multiSelect: false,
  options: [
    { label: "Red", description: "warm", preview: "R\nG\nB" },
    { label: "Green", description: "cool" },
  ],
};
const toppingsQ = {
  header: "Toppings",
  question: "Pick toppings",
  multiSelect: true,
  options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Mushroom" }],
};

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.append(container);
});

function mount(client: ChatClient, msg: ChatMessage) {
  const store = createChatStore(SID);
  store.hydrate([msg]);
  return mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });
}

describe("AskUserQuestion card — fallback (no answerQuestion)", () => {
  it("renders option buttons and sends the label as a message on click", () => {
    const client = makeClient(); // no answerQuestion -> fallback
    mount(client, questionMsg([colorQ]));
    const opts = container.querySelectorAll<HTMLButtonElement>(".chat-question-option");
    expect(opts.length).toBe(2);
    opts[1].click();
    expect(client.send).toHaveBeenCalledWith(SID, "Green");
    expect(client.answerQuestion).toBeUndefined();
  });
});

describe("AskUserQuestion card — interactive (live terminal)", () => {
  it("shows header, description and preview", () => {
    const client = makeClient({ answerQuestion: vi.fn(async () => {}) });
    mount(client, questionMsg([colorQ]));
    expect(container.querySelector(".chat-question-header")?.textContent).toBe("Color");
    expect(container.textContent).toContain("Pick a color");
    expect(container.querySelector(".chat-question-option-desc")?.textContent).toBe("warm");
    expect(container.querySelector(".chat-question-preview")?.textContent).toBe("R\nG\nB");
  });

  it("lone single-select submits immediately on option click", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([colorQ]));
    container.querySelectorAll<HTMLButtonElement>(".chat-question-option")[1].click();
    expect(answerQuestion).toHaveBeenCalledWith(SID, "t1", {
      kind: "submit",
      answers: [{ kind: "option", index: 1 }],
    });
  });

  it("multiSelect collects toggled checkboxes and submits via the Submit button", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([toppingsQ]));
    const boxes = container.querySelectorAll<HTMLInputElement>(".chat-question-check input");
    expect(boxes.length).toBe(3);
    const submit = container.querySelector(".chat-question-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nothing checked yet
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change"));
    boxes[2].checked = true;
    boxes[2].dispatchEvent(new Event("change"));
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(answerQuestion).toHaveBeenCalledWith(SID, "t1", {
      kind: "submit",
      answers: [{ kind: "multi", indexes: [0, 2] }],
    });
  });

  it("multiple questions require all answers before Submit, then sends them in order", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([colorQ, toppingsQ]));
    const submit = container.querySelector(".chat-question-submit") as HTMLButtonElement;
    const questions = container.querySelectorAll(".chat-question");
    // Answer Q1 (single-select Green = index 1).
    questions[0].querySelectorAll<HTMLButtonElement>(".chat-question-option")[1].click();
    expect(submit.disabled).toBe(true); // Q2 still unanswered
    // Answer Q2 (toggle Olives = index 1).
    const q2box = questions[1].querySelectorAll<HTMLInputElement>(".chat-question-check input")[1];
    q2box.checked = true;
    q2box.dispatchEvent(new Event("change"));
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(answerQuestion).toHaveBeenCalledWith(SID, "t1", {
      kind: "submit",
      answers: [
        { kind: "option", index: 1 },
        { kind: "multi", indexes: [1] },
      ],
    });
  });

  it("an Other free-text entry becomes the answer, submitted via the button", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([colorQ]));
    const submit = container.querySelector(".chat-question-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const other = container.querySelector(".chat-question-other") as HTMLInputElement;
    other.value = "Magenta";
    other.dispatchEvent(new Event("input"));
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(answerQuestion).toHaveBeenCalledWith(SID, "t1", {
      kind: "submit",
      answers: [{ kind: "other", text: "Magenta" }],
    });
  });

  it("Chat about this declines and focuses the composer", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([colorQ]));
    (container.querySelector(".chat-question-chat") as HTMLButtonElement).click();
    expect(answerQuestion).toHaveBeenCalledWith(SID, "t1", { kind: "chat" });
  });

  it("an answered question renders read-only (no controls)", () => {
    const answerQuestion = vi.fn(async () => {});
    const client = makeClient({ answerQuestion });
    mount(client, questionMsg([colorQ], "done"));
    expect(container.querySelector(".chat-questions-answered")).toBeTruthy();
    expect(container.querySelector(".chat-question-submit")).toBeNull();
    expect(container.querySelector(".chat-question-option")).toBeNull();
    expect(container.querySelector(".chat-question-chat")).toBeNull();
  });
});
