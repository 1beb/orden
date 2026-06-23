// Annotation-to-session delivery: hand an annotation (or a batch) to the agent
// working a plan doc. The host types the rendered text into the agent's live
// tmux pane — the TUI's own input queue holds it for the agent's next turn. If
// the session has no live pane, we stash the text as the session's initialPrompt
// and relaunch it (resuming the conversation), so it lands on the next start.
//
// The pure decision (which session, single vs batch, live vs dead) lives here and
// is unit-tested against a faked PaneOps so the tests never touch tmux. The real
// PaneOps (defaultPaneOps) wraps tmux has-session / send-keys and launchDetached.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Host } from "@orden/host-api";
import {
  sessionsForDoc,
  recordDocLink,
  rid,
  renderSingle,
  renderBatch,
  type DeliverableAnnotation,
} from "@orden/mcp";
import { tmuxNameFor, launchDetached } from "./terminal";
import { listLocalProjectRoots } from "./projectRoots";
import type { KeyOp } from "./chat/questionKeystrokes";

const exec = promisify(execFile);

export type Delivered = "queued" | "relaunched" | "failed";

export interface QueueResult {
  delivered: Delivered;
  sessionId: string;
}

// The side-effecting surface queueToSession depends on. Injected so the branch
// logic is testable without running tmux. defaultPaneOps is the real one.
export interface PaneOps {
  /** True if the session's agent has a live tmux pane to type into. */
  isLive(sessionId: string): Promise<boolean>;
  /** Type `text` into the live pane as a literal, then submit (Enter). */
  sendText(sessionId: string, text: string): Promise<void>;
  /** Send a raw keystroke sequence (literals + named keys) to the live pane —
   *  used to drive claude's interactive AskUserQuestion menu. No trailing Enter. */
  sendKeys(sessionId: string, ops: KeyOp[]): Promise<void>;
  /** (Re)launch the session's detached agent — picks up a queued initialPrompt. */
  relaunch(sessionId: string): Promise<void>;
}

// Real tmux-backed ops. defaultCwd is where a relaunch starts the agent.
export function defaultPaneOps(host: Host, defaultCwd: string): PaneOps {
  return {
    async isLive(sessionId) {
      // `tmux has-session` exits 0 iff the session exists. Swallow the non-zero
      // (and any tmux-missing) error as "not live".
      try {
        await exec("tmux", ["has-session", "-t", tmuxNameFor(sessionId)]);
        return true;
      } catch {
        return false;
      }
    },
    async sendText(sessionId, text) {
      const target = tmuxNameFor(sessionId);
      // -l sends the text literally (no key-name interpretation), so quotes,
      // brackets, and newlines in the rendered message survive. A separate
      // send-keys Enter submits it — the TUI queues it for the agent's turn.
      await exec("tmux", ["send-keys", "-t", target, "-l", text]);
      await exec("tmux", ["send-keys", "-t", target, "Enter"]);
    },
    async sendKeys(sessionId, ops) {
      const target = tmuxNameFor(sessionId);
      // One send-keys per op, in order: a literal goes through `-l` (no key-name
      // interpretation, so digits/text are typed verbatim); a named key (Enter,
      // Right) is sent by name so tmux maps it to the control sequence. claude's
      // menu reacts to each keypress, so the ordering here is the choreography.
      for (const op of ops) {
        if (op.type === "literal") {
          await exec("tmux", ["send-keys", "-t", target, "-l", op.value]);
        } else {
          await exec("tmux", ["send-keys", "-t", target, op.name]);
        }
      }
    },
    async relaunch(sessionId) {
      await launchDetached(host, defaultCwd, sessionId);
    },
  };
}

// Deliver `text` to one session. Live pane → type it in (queued). No pane →
// stash it as initialPrompt + pendingLaunch and relaunch (relaunched). Never
// throws: any failure resolves as { delivered: "failed" }, mirroring
// launchDetached's swallow-and-warn contract.
export async function queueToSession(
  host: Host,
  sessionId: string,
  text: string,
  ops: PaneOps,
): Promise<QueueResult> {
  try {
    if (await ops.isLive(sessionId)) {
      await ops.sendText(sessionId, text);
      return { delivered: "queued", sessionId };
    }
    // Dead: queue the text on the record so the relaunch (and any future first
    // open) hands it to the agent, then relaunch via the detached path.
    const rec = await host.vault.get<Record<string, unknown>>("sessions", sessionId);
    if (rec) {
      await host.vault.set("sessions", sessionId, {
        ...rec,
        initialPrompt: text,
        pendingLaunch: true,
      });
    }
    await ops.relaunch(sessionId);
    return { delivered: "relaunched", sessionId };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`orden: queueToSession failed for ${sessionId}:`, err);
    return { delivered: "failed", sessionId };
  }
}

export type AnnotationSendResult =
  | { ok: false; reason: string }
  | { ok: true; target: string; delivered: Delivered; count: number };

export interface AnnotationSendInput {
  planDoc: string;
  annotations: DeliverableAnnotation[];
  /** Project the doc belongs to; used when creating a session for an unowned doc
   *  so it lands in the right project rather than the ephemeral default. */
  projectId?: string;
}

// The local project whose root contains `docPath` (longest match wins), else
// "homeroom" — the default ephemeral project — so a doc that belongs to no
// project still gets a home. Mirrors sessionByWorkdir's path-boundary check.
async function projectForDocPath(host: Host, docPath: string): Promise<string> {
  let best = "homeroom";
  let bestLen = -1;
  for (const { id, root } of await listLocalProjectRoots(host)) {
    const prefix = root.endsWith("/") ? root : root + "/";
    if ((docPath === root || docPath.startsWith(prefix)) && root.length > bestLen) {
      best = id;
      bestLen = root.length;
    }
  }
  return best;
}

// No session backs the doc yet: create one in the doc's project (or homeroom),
// queue the annotation as its initial prompt so it lands when the agent starts,
// and record the doc→session link so later sends reach the same session. The
// host's launch-on-create reactor spawns the agent when pendingLaunch is set.
async function createSessionForDoc(
  host: Host,
  docPath: string,
  text: string,
  projectIdHint?: string,
): Promise<string> {
  // Prefer the caller's project (the web knows which project the doc was opened
  // from) over a root-prefix guess, which fails for the relative paths the web
  // sends and would otherwise land the session in the ephemeral default.
  const projectId = projectIdHint ?? (await projectForDocPath(host, docPath));
  const sessionId = rid("sess");
  const title = `Review: ${docPath.split("/").pop() ?? docPath}`;
  const settings = await host.vault.get<{ sessionAutoLaunch?: boolean }>("settings", "app");
  const autoLaunch = settings?.sessionAutoLaunch !== false;
  await host.vault.set("sessions", sessionId, {
    id: sessionId,
    title,
    agent: "claude",
    projectId,
    initialPrompt: text,
    ...(autoLaunch ? { pendingLaunch: true } : {}),
  });
  const cardId = rid("item");
  await host.vault.set("cards", cardId, {
    id: cardId,
    title,
    state: "planning",
    projectId,
    sessionIds: [sessionId],
    planDoc: docPath,
  });
  await recordDocLink(host.vault, docPath, sessionId);
  return sessionId;
}

// Resolve the session behind a doc (explicit planDoc link, recorded open-time
// link, or owning worktree), pick a target (a live one, else the most recent),
// render single vs batch, and deliver. When NO session backs the doc, create
// one in the doc's project (or homeroom) with the annotation queued — so review
// feedback always has somewhere to go.
export async function annotationSend(
  host: Host,
  input: AnnotationSendInput,
  ops: PaneOps,
): Promise<AnnotationSendResult> {
  const { sessionIds } = await sessionsForDoc(host.vault, input.planDoc);

  const count = input.annotations.length;
  const text =
    count === 1
      ? renderSingle(input.annotations[0])
      : renderBatch(input.planDoc, input.annotations);

  if (sessionIds.length === 0) {
    const sessionId = await createSessionForDoc(host, input.planDoc, text, input.projectId);
    return { ok: true, target: sessionId, delivered: "relaunched", count };
  }

  // Prefer a session with a live pane; else the most recent (last appended).
  let target = sessionIds[sessionIds.length - 1];
  for (const id of sessionIds) {
    if (await ops.isLive(id)) {
      target = id;
      break;
    }
  }

  const r = await queueToSession(host, target, text, ops);
  return { ok: true, target, delivered: r.delivered, count };
}
