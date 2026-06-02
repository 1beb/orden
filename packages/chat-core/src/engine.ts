import type {
  ChatBackend,
  ChatHarness,
  ChatMessage,
  ChatSession,
  HarnessDriver,
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
}): ChatBackend {
  const { vault, registry } = deps;
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
    void (async () => {
      for await (const ev of l.driver.events) {
        await l.reducer.apply(ev);
      }
    })().catch((err) => {
      // A pump failure silently ends the session's event stream; surface it
      // rather than letting it die as an unhandled rejection. Task 10 (host
      // wiring) can route this to a real logger / session-error state.
      console.error(`chat engine: pump failed for session ${sessionId}:`, err);
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
      const keys = await vault.list(sessNs(sessionId));
      const msgKeys = keys
        .filter((k) => k.startsWith("msg:"))
        .sort((a, b) => Number.parseInt(a.slice(4), 10) - Number.parseInt(b.slice(4), 10));
      const out: ChatMessage[] = [];
      for (const k of msgKeys) {
        const m = await vault.get<ChatMessage>(sessNs(sessionId), k);
        if (m) out.push(m);
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
      await vault.delete(sessNs(sessionId), `perm:${reqId}`);
      resolve({ allow: d.decision === "allow" });
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
