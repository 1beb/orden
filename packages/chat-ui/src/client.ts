import type {
  ChatSession,
  ChatMessage,
  ChatHarness,
  KeyedMessage,
  ModelOption,
  SlashCommand,
  PermissionDecision,
  QuestionResponse,
} from "@orden/chat-core";

// Transport-agnostic surface the UI calls. Mirrors ChatBackend's method shapes
// but depends ONLY on @orden/chat-core types, never on host-api — so the UI can
// be wired over any transport (in-process, RPC, ws) without coupling.
export interface ChatClient {
  listSessions(): Promise<ChatSession[]>;
  createSession(opts: {
    harness: ChatHarness;
    cwd: string;
    title?: string;
    model?: string;
  }): Promise<ChatSession>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
  getMessagesKeyed(sessionId: string): Promise<KeyedMessage[]>;
  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void>;
  respondPermission(sessionId: string, reqId: string, d: PermissionDecision): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  listModels(harness: ChatHarness): Promise<ModelOption[]>;
  listCommands(sessionId: string): Promise<SlashCommand[]>;
  // Answer a pending AskUserQuestion. Only mirrored-terminal sessions implement
  // this (it drives the live TUI menu); when absent, the question card falls back
  // to sending an option label as a plain message.
  answerQuestion?(sessionId: string, toolId: string, response: QuestionResponse): Promise<void>;
}
