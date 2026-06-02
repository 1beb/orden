// The engine + registry are part of the package's public surface so hosts can
// build a ChatBackend without reaching into internal module paths.
export { createChatBackend } from "./engine";
export { AdapterRegistry, defaultRegistry } from "./registry";

export type ChatHarness = "claude" | "opencode";

export interface ChatSession {
  id: string;
  title: string;
  harness: ChatHarness;
  cwd: string;
  model?: string;
  createdAt: number;
  /** Slash commands the harness advertised for this session (from the init event). */
  slashCommands?: string[];
}

export type ChatPart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolId: string;
      name: string;
      input: unknown;
      state: "pending" | "running" | "done" | "error";
      output?: string;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: ChatPart[];
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
  title: string;
}

export interface ModelOption {
  harness: ChatHarness;
  id: string; // opaque to the UI; the adapter translates it to its native form
  label: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
}

export interface PermissionDecision {
  decision: "allow" | "deny";
  remember?: boolean;
}

// The public surface, implemented once by a generic engine (built later).
export interface ChatBackend {
  listSessions(): Promise<ChatSession[]>;
  createSession(opts: {
    harness: ChatHarness;
    cwd: string;
    title?: string;
    model?: string;
  }): Promise<ChatSession>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void>;
  respondPermission(sessionId: string, reqId: string, d: PermissionDecision): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  listModels(harness: ChatHarness): Promise<ModelOption[]>;
  listCommands(sessionId: string): Promise<SlashCommand[]>;
}

// ---- Modular contracts (the harness extension point) ----

// One normalized event stream that EVERY harness adapter emits.
export type DriverEvent =
  | { kind: "session"; sessionId: string; slashCommands: string[] }
  | { kind: "text"; messageId: string; text: string }
  | { kind: "tool"; messageId: string; toolId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolId: string; output: string; ok: boolean }
  | { kind: "turn-end" };

// A per-session live connection to one harness.
export interface HarnessDriver {
  events: AsyncIterable<DriverEvent>;
  send(text: string): Promise<void>; // text may be a slash command like "/commit"
  setModel(model: string): Promise<void>;
  listCommands(): Promise<SlashCommand[]>;
  // The driver invokes cb when the harness asks to use a tool; cb resolves allow/deny.
  // Intentionally a plain boolean, not PermissionDecision: the engine owns the
  // `remember` policy and only relays a yes/no to the driver.
  onPermission(
    cb: (req: { toolName: string; input: unknown; title: string }) => Promise<{ allow: boolean }>,
  ): void;
  close(): Promise<void>;
}

// A pluggable harness. Adding a harness = implementing this + registering it.
// `harness` is the ChatHarness union (not `string`) so the registry and sessions
// stay type-safe; adding a harness widens the union here — a deliberate one-line
// edit, kept narrow on purpose rather than opening it to arbitrary strings.
export interface HarnessAdapter {
  harness: ChatHarness;
  listModels(): Promise<ModelOption[]>;
  open(opts: { cwd: string; model?: string }): HarnessDriver;
}

// Minimal vault port the engine writes through. Structurally identical to
// host-api's VaultStore, but declared here so chat-core has no host-api dep.
export interface ChatVault {
  get<T>(ns: string, key: string): Promise<T | null>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
  list(ns: string): Promise<string[]>;
  delete(ns: string, key: string): Promise<void>;
}
