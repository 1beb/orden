import type {
  ChatBackend,
  ChatHarness,
  ChatMessage,
  ChatSession,
  HarnessDriver,
  KeyedMessage,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  SlashCommand,
} from "./index";
import { AdapterRegistry } from "./registry";
import { VaultReducer } from "./reduceToVault";
import type { ChatVault } from "./index";

// Live per-session state held only while a driver is open in THIS engine
// instance. Reads (getMessages/listSessions) never touch this — they replay
// from the vault — so a fresh engine over the same vault resumes reads without
// re-opening a driver. Methods that need the live wire (send/setModel/
// listCommands/respondPermission) require the session to have been opened in
// this instance.
interface Live {
  driver: HarnessDriver;
  reducer: VaultReducer;
  // Parked permission resolvers, keyed by permId. The driver's onPermission cb
  // returns a Promise we park here; respondPermission resolves it.
  pending: Map<string, (d: { allow: boolean }) => void>;
}

const sessNs = (id: string) => `chat:${id}`;
const INDEX_NS = "chat-index";
const INDEX_KEY = "ids";

export function createChatBackend(deps: {
  vault: ChatVault;
  registry: AdapterRegistry;
  genId?: () => string;
  now?: () => number;
  // Turn-boundary callback. Fired with this engine's chat session id and the
  // edge of a turn: "start" on the FIRST driver event after idle, "end" on
  // `turn-end`. GUI-mode sessions have no tmux pane and so never fire the
  // claude `--settings` lifecycle hooks that drive kanban card state; the host
  // uses this callback to reflect working/waiting onto the session's card. Kept
  // as a plain callback so chat-core stays free of host-api/kanban deps.
  onTurnBoundary?: (sessionId: string, edge: "start" | "end") => void;
}): ChatBackend {
  const { vault, registry } = deps;
  const onTurnBoundary = deps.onTurnBoundary;
  const genId = deps.genId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const live = new Map<string, Live>();

  function requireLive(sessionId: string): Live {
    const l = live.get(sessionId);
    if (!l) throw new Error(`Session "${sessionId}" is not open in this engine instance`);
    return l;
  }

  // Detached pump: drains the driver's async event stream into the reducer.
  // Not awaited by createSession so it runs concurrently for the session's life.
  function startPump(sessionId: string, l: Live): void {
    // Per-session in-turn latch: the first event after idle is a turn "start";
    // `turn-end` is a turn "end" and re-arms the latch. The `session` event
    // (the harness handshake) is not real work, so it does not start a turn.
    // Hoisted out of the loop so the catch below can close the turn on failure.
    let inTurn = false;
    void (async () => {
      for await (const ev of l.driver.events) {
        if (onTurnBoundary && ev.kind !== "session" && !inTurn) {
          inTurn = true;
          onTurnBoundary(sessionId, "start");
        }
        await l.reducer.apply(ev);
        if (ev.kind === "turn-end") {
          inTurn = false;
          if (onTurnBoundary) onTurnBoundary(sessionId, "end");
        }
      }
    })().catch(async (err) => {
      // A pump failure silently ends the session's event stream. Log it, then
      // surface it into the transcript as a visible error part so the Chat view
      // shows the failure instead of a half-streamed reply, and fire the
      // turn-end boundary so a GUI session's card doesn't stay stuck "working".
      console.error(`chat engine: pump failed for session ${sessionId}:`, err);
      try {
        await l.reducer.applyError(
          `stream ended unexpectedly: ${String((err as { message?: unknown })?.message ?? err)}`,
        );
      } catch (inner) {
        console.error(`chat engine: failed to record error for session ${sessionId}:`, inner);
      }
      if (inTurn && onTurnBoundary) onTurnBoundary(sessionId, "end");
    });
  }

  return {
    async listSessions(): Promise<ChatSession[]> {
      const ids = (await vault.get<string[]>(INDEX_NS, INDEX_KEY)) ?? [];
      const out: ChatSession[] = [];
      for (const id of ids) {
        const meta = await vault.get<ChatSession>(sessNs(id), "meta");
        if (meta) out.push(meta);
      }
      return out;
    },

    async createSession(opts: {
      harness: ChatHarness;
      cwd: string;
      title?: string;
      model?: string;
    }): Promise<ChatSession> {
      const id = genId();
      const session: ChatSession = {
        id,
        title: opts.title ?? "",
        harness: opts.harness,
        cwd: opts.cwd,
        model: opts.model,
        createdAt: now(),
      };
      await vault.set(sessNs(id), "meta", session);
      const ids = (await vault.get<string[]>(INDEX_NS, INDEX_KEY)) ?? [];
      ids.push(id);
      await vault.set(INDEX_NS, INDEX_KEY, ids);

      const adapter = registry.get(opts.harness);
      const driver = adapter.open({ cwd: opts.cwd, model: opts.model });
      const l: Live = { driver, reducer: new VaultReducer(vault, id), pending: new Map() };
      live.set(id, l);

      driver.onPermission(async (req) => {
        const permId = genId();
        const perm: PermissionRequest = {
          id: permId,
          toolName: req.toolName,
          input: req.input,
          title: req.title,
        };
        await vault.set(sessNs(id), `perm:${permId}`, perm);
        return new Promise<{ allow: boolean }>((resolve) => {
          l.pending.set(permId, resolve);
        });
      });

      startPump(id, l);
      return session;
    },

    async getMessages(sessionId: string): Promise<ChatMessage[]> {
      return (await this.getMessagesKeyed(sessionId)).map((e) => e.message);
    },

    async getMessagesKeyed(sessionId: string): Promise<KeyedMessage[]> {
      const keys = await vault.list(sessNs(sessionId));
      const msgKeys = keys
        .filter((k) => k.startsWith("msg:"))
        .map((k) => ({ k, seq: Number.parseInt(k.slice(4), 10) }))
        .filter(({ seq }) => !Number.isNaN(seq))
        .sort((a, b) => a.seq - b.seq);
      const out: KeyedMessage[] = [];
      for (const { k, seq } of msgKeys) {
        const m = await vault.get<ChatMessage>(sessNs(sessionId), k);
        if (m) out.push({ seq, message: m });
      }
      return out;
    },

    async send(sessionId: string, text: string, opts?: { model?: string }): Promise<void> {
      const l = requireLive(sessionId);
      if (opts?.model) await l.driver.setModel(opts.model);
      await l.driver.send(text);
    },

    async respondPermission(
      sessionId: string,
      reqId: string,
      d: PermissionDecision,
    ): Promise<void> {
      const l = requireLive(sessionId);
      const resolve = l.pending.get(reqId);
      if (!resolve) return; // unknown / already-resolved: no-op
      l.pending.delete(reqId);
      // Resolve the driver's permission promise BEFORE the vault delete: a failed
      // delete would otherwise wedge the tool call forever (resolver unreachable).
      // A stale perm: key left behind is the lesser evil. `remember` is dropped
      // deliberately — the engine has no allow-list policy yet (deferred).
      resolve({ allow: d.decision === "allow" });
      await vault.delete(sessNs(sessionId), `perm:${reqId}`);
    },

    async setModel(sessionId: string, model: string): Promise<void> {
      await requireLive(sessionId).driver.setModel(model);
    },

    async listModels(harness: ChatHarness): Promise<ModelOption[]> {
      return registry.get(harness).listModels();
    },

    async listCommands(sessionId: string): Promise<SlashCommand[]> {
      return requireLive(sessionId).driver.listCommands();
    },
  };
}
