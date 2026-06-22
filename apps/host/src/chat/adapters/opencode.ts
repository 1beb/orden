import { createOpencode } from "@opencode-ai/sdk";
import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import type {
  DriverEvent,
  HarnessAdapter,
  HarnessDriver,
  ModelOption,
  SlashCommand,
} from "@orden/chat-core";
import { OpencodeTranslator } from "../opencodeEventToEvents";

// A live connection to an opencode server + client. `close` tears down the
// spawned server. Injected in tests via the fake `connect`.
export interface OpencodeConnection {
  client: OpencodeClient;
  close: () => void;
}

export type ConnectFn = () => Promise<OpencodeConnection>;

// Default connection: spawn an opencode server and return its client. `close`
// shuts the server down (the client has no separate lifecycle).
export async function defaultConnect(): Promise<OpencodeConnection> {
  const { client, server } = await createOpencode();
  return { client, close: () => server.close() };
}

// Decode a `providerID/modelID` model id (our opaque ModelOption.id) back into
// the {providerID, modelID} pair opencode's prompt body wants. Only the first
// "/" separates them; model ids themselves may contain slashes.
function decodeModel(id: string): { providerID: string; modelID: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

// Split a leading-slash send like "/init the rest" into a command name and its
// argument string, matching session.command's {command, arguments} body.
function parseCommand(text: string): { command: string; arguments: string } {
  const body = text.slice(1); // drop leading "/"
  const sp = body.indexOf(" ");
  if (sp === -1) return { command: body, arguments: "" };
  return { command: body.slice(0, sp), arguments: body.slice(sp + 1) };
}

type PermissionCb = (req: {
  toolName: string;
  input: unknown;
  title: string;
}) => Promise<{ allow: boolean }>;

export function makeOpencodeAdapter(deps?: { connect?: ConnectFn }): HarnessAdapter {
  const connect: ConnectFn = deps?.connect ?? defaultConnect;

  return {
    harness: "opencode",

    // The model catalog needs a live connection (config.providers). Connect,
    // read, and tear the connection right back down so listModels stays a pure
    // query with no lingering server.
    async listModels(): Promise<ModelOption[]> {
      const conn = await connect();
      try {
        const res = await conn.client.config.providers();
        const data = res.data;
        if (!data) return [];
        const out: ModelOption[] = [];
        for (const provider of data.providers) {
          for (const model of Object.values(provider.models)) {
            out.push({
              harness: "opencode",
              id: `${provider.id}/${model.id}`,
              label: `${model.name} (${provider.name})`,
            });
          }
        }
        return out;
      } finally {
        conn.close();
      }
    },

    open({ cwd, model: initialModel }: { cwd: string; model?: string }): HarnessDriver {
      let model = initialModel;
      let permissionCb: PermissionCb | null = null;
      let closed = false;

      // Resolved once open() has a session id + a live connection; send/control
      // calls await it so they never race ahead of session creation.
      let connResolve!: (c: OpencodeConnection) => void;
      let connReject!: (e: unknown) => void;
      const connReady = new Promise<OpencodeConnection>((res, rej) => {
        connResolve = res;
        connReject = rej;
      });
      let sessionResolve!: (id: string) => void;
      let sessionReject!: (e: unknown) => void;
      const sessionReady = new Promise<string>((res, rej) => {
        sessionResolve = res;
        sessionReject = rej;
      });
      // A consumer that only reads `events` never awaits these, so a background
      // connect/create failure would surface as an unhandledRejection. Attach
      // inert catches: real awaiters (send/control/close) still observe the
      // rejection; the failure also ends the events stream via `pumpEnded`.
      connReady.catch(() => {});
      sessionReady.catch(() => {});

      // Single-producer queue bridging the SSE pump to the events generator.
      const out: DriverEvent[] = [];
      let pump: (() => void) | null = null;
      let pumpEnded = false;
      const wake = () => {
        if (pump) {
          const p = pump;
          pump = null;
          p();
        }
      };

      // Background: establish the connection, create the session, subscribe to
      // the SSE stream, and route this session's events into `out` (or the
      // permission round-trip). Errors end the generator rather than throw.
      let conn: OpencodeConnection | null = null;
      void (async () => {
        try {
          conn = await connect();
          connResolve(conn);
          if (closed) return; // closed mid-connect: don't create/subscribe on a torn-down conn

          const created = await conn.client.session.create({
            query: cwd ? { directory: cwd } : undefined,
          });
          const sessionId = created.data?.id;
          if (!sessionId) throw new Error("opencode adapter: session.create returned no id");
          sessionResolve(sessionId);
          if (closed) return;
          out.push({ kind: "session", sessionId, slashCommands: [] });
          wake();

          // Root-gate the turn boundary: only the root session's idle ends the
          // turn (subagents/title/compaction sessions each emit their own).
          const translator = new OpencodeTranslator(sessionId);
          const sub = await conn.client.event.subscribe();
          for await (const event of sub.stream as AsyncIterable<Event>) {
            if (closed) break;
            if (!eventBelongsTo(event, sessionId)) continue;
            // Permissions are out-of-band: run onPermission, POST the decision,
            // and never feed them through the translator.
            if (event.type === "permission.updated") {
              await handlePermission(conn.client, event, sessionId);
              continue;
            }
            for (const ev of translator.translate(event)) {
              out.push(ev);
            }
            wake();
          }
        } catch (err) {
          // Surface the failure to both await channels so neither send() (which
          // awaits sessionReady) nor close() can deadlock waiting on a session
          // that will never be created.
          connReject(err);
          sessionReject(err);
        } finally {
          pumpEnded = true;
          wake();
        }
      })();

      async function handlePermission(
        client: OpencodeClient,
        event: Extract<Event, { type: "permission.updated" }>,
        sessionId: string,
      ): Promise<void> {
        const perm = event.properties;
        let allow = false;
        if (permissionCb) {
          const decision = await permissionCb({
            toolName: typeof perm.type === "string" ? perm.type : "tool",
            input: perm.metadata ?? {},
            title: perm.title,
          });
          allow = decision.allow;
        }
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: perm.id },
          body: { response: allow ? "once" : "reject" },
        });
      }

      async function* events(): AsyncGenerator<DriverEvent, void> {
        try {
          while (true) {
            if (out.length > 0) {
              yield out.shift()!;
              continue;
            }
            if (pumpEnded || closed) return;
            await new Promise<void>((resolve) => {
              pump = resolve;
            });
          }
        } finally {
          closed = true;
        }
      }

      return {
        events: events(),

        async send(text: string): Promise<void> {
          if (closed) throw new Error("opencode adapter: send() after close()");
          const client = (await connReady).client;
          const id = await sessionReady;
          if (text.startsWith("/")) {
            const { command, arguments: args } = parseCommand(text);
            await client.session.command({
              path: { id },
              body: { command, arguments: args, ...(model ? { model } : {}) },
            });
            return;
          }
          const decoded = model ? decodeModel(model) : undefined;
          await client.session.prompt({
            path: { id },
            body: { parts: [{ type: "text", text }], ...(decoded ? { model: decoded } : {}) },
          });
        },

        // opencode has no live model switch; the model is applied per-prompt, so
        // we just remember it and pass it on the next send().
        async setModel(m: string): Promise<void> {
          model = m;
        },

        async listCommands(): Promise<SlashCommand[]> {
          const client = (await connReady).client;
          const res = await client.command.list();
          const cmds = res.data ?? [];
          return cmds.map((c) => ({ name: c.name, description: c.description }));
        },

        onPermission(cb): void {
          permissionCb = cb;
        },

        async close(): Promise<void> {
          closed = true;
          wake();
          // Best-effort: the SSE loop's connect may still be in flight.
          try {
            const c = conn ?? (await connReady);
            c.close();
          } catch {
            // connection never established; nothing to tear down.
          }
        },
      };
    },
  };
}

// Every opencode SSE event we care about carries a sessionID somewhere in its
// properties; keep only those for our session (and the session-less ones we
// already filtered out by type are simply ignored downstream).
export function eventBelongsTo(event: Event, sessionId: string): boolean {
  const props = (event as { properties?: Record<string, unknown> }).properties;
  if (!props) return false;
  if (typeof props.sessionID === "string") return props.sessionID === sessionId;
  // message.part.updated nests the id under properties.part.sessionID.
  const part = props.part as { sessionID?: string } | undefined;
  if (part && typeof part.sessionID === "string") return part.sessionID === sessionId;
  // message.updated nests it under properties.info.sessionID.
  const info = props.info as { sessionID?: string } | undefined;
  if (info && typeof info.sessionID === "string") return info.sessionID === sessionId;
  return false;
}
