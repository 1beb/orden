import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChatMessage,
  ChatHarness,
  ModelOption,
  PermissionRequest,
  SlashCommand,
} from "@orden/chat-core";
import { createChatStore } from "../src/chatStore";
import type { ChatClient } from "../src/client";
import { mountChatView } from "../src/chatView";

const SID = "sess-1";
const HARNESS: ChatHarness = "claude";

function makeClient(over: Partial<ChatClient> = {}): ChatClient {
  return {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(),
    getMessages: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    respondPermission: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    listModels: vi.fn(async (): Promise<ModelOption[]> => [
      { harness: HARNESS, id: "m1", label: "Model One" },
    ]),
    listCommands: vi.fn(async (): Promise<SlashCommand[]> => [
      { name: "commit", description: "make a commit" },
    ]),
    ...over,
  } as ChatClient;
}

const md = (t: string) => document.createTextNode(t);

const hydrated: ChatMessage = {
  id: "a",
  role: "assistant",
  parts: [
    { type: "text", text: "hello world" },
    {
      type: "tool",
      toolId: "t1",
      name: "Bash",
      input: { command: "ls" },
      state: "done",
      output: "file.txt",
    },
  ],
};

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.append(container);
});

// Microtask flush for the async client.* fetches.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mountChatView", () => {
  it("renders text parts and an expandable tool card with a state badge", async () => {
    const store = createChatStore(SID);
    store.hydrate([hydrated]);
    const client = makeClient();
    const view = mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });

    expect(container.textContent).toContain("hello world");

    const tool = container.querySelector(".chat-tool") as HTMLDetailsElement;
    expect(tool).toBeTruthy();
    expect(tool.querySelector(".chat-tool-name")?.textContent).toBe("Bash");
    const badge = tool.querySelector(".chat-tool-badge");
    expect(badge?.textContent).toBe("done");
    expect(badge?.className).toContain("chat-tool-badge-done");

    // Output is present in the body (details/summary keeps it keyboard-clickable).
    expect(tool.querySelector(".chat-tool-output")?.textContent).toBe("file.txt");
    expect(tool.querySelector(".chat-tool-input")?.textContent).toContain("ls");

    view.dispose();
  });

  it("renders Allow/Deny for a pending permission and wires respondPermission", () => {
    const store = createChatStore(SID);
    store.hydrate([hydrated]);
    const client = makeClient();
    mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });

    const req: PermissionRequest = { id: "p1", toolName: "Bash", input: {}, title: "Run ls?" };
    store.applyChange(`chat:${SID}`, "perm:p1", req);

    const perm = container.querySelector(".chat-perm");
    expect(perm?.textContent).toContain("Run ls?");
    expect(perm?.textContent).toContain("Bash");

    const allow = container.querySelector(".chat-perm-allow") as HTMLButtonElement;
    const deny = container.querySelector(".chat-perm-deny") as HTMLButtonElement;
    expect(allow).toBeTruthy();
    expect(deny).toBeTruthy();

    allow.click();
    expect(client.respondPermission).toHaveBeenCalledWith(SID, "p1", { decision: "allow" });
    expect(allow.disabled).toBe(true);
  });

  it("sends on click and clears the input", () => {
    const store = createChatStore(SID);
    const client = makeClient();
    mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });

    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "do the thing";
    (container.querySelector(".chat-send") as HTMLButtonElement).click();

    expect(client.send).toHaveBeenCalledWith(SID, "do the thing");
    expect(input.value).toBe("");
  });

  it("populates the model select and calls setModel on change", async () => {
    const store = createChatStore(SID);
    const client = makeClient();
    mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });
    expect(client.listModels).toHaveBeenCalledWith(HARNESS);

    await flush();
    const select = container.querySelector(".chat-model-select") as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].value).toBe("m1");

    select.value = "m1";
    select.dispatchEvent(new Event("change"));
    expect(client.setModel).toHaveBeenCalledWith(SID, "m1");
  });

  it("shows the slash command palette lazily on '/' and fills the input on select", async () => {
    const store = createChatStore(SID);
    const client = makeClient();
    mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });

    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "/co";
    input.dispatchEvent(new Event("input"));
    await flush();

    expect(client.listCommands).toHaveBeenCalledWith(SID);
    const items = container.querySelectorAll(".chat-command-item");
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe("/commit");

    (items[0] as HTMLButtonElement).click();
    expect(input.value).toBe("/commit ");
  });

  it("dispose empties the container and unsubscribes", () => {
    const store = createChatStore(SID);
    store.hydrate([hydrated]);
    const client = makeClient();
    const view = mountChatView({ container, store, client, sessionId: SID, harness: HARNESS, renderMarkdown: md });
    expect(container.childNodes.length).toBeGreaterThan(0);

    view.dispose();
    expect(container.childNodes.length).toBe(0);

    // A later store change must not throw or re-populate the container.
    expect(() => store.applyChange(`chat:${SID}`, "msg:0001", hydrated)).not.toThrow();
    expect(container.childNodes.length).toBe(0);
  });
});
