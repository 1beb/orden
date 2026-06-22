import type { Event } from "@opencode-ai/sdk";
import type { DriverEvent } from "@orden/chat-core";

// Stateful normalization of opencode SSE `Event`s into the shared DriverEvent
// stream. Stateful because opencode streams growing SNAPSHOTS, not deltas:
//
//   - A text part's `message.part.updated` carries the FULL accumulated text
//     each time. The downstream reducer concatenates consecutive same-messageId
//     `text` events, so emitting each snapshot verbatim would duplicate text.
//     We track how much of each text part we've already emitted and yield only
//     the new suffix.
//   - A tool part progresses pending -> running -> completed|error, re-sent in
//     full each step. We emit one `tool` event the first time we see it and one
//     `tool-result` when it terminates (completed=ok, error=fail), then nothing.
//
// Permission events are NOT handled here — the adapter intercepts them and runs
// the out-of-band onPermission round-trip (like claude's canUseTool). The only
// turn-boundary signal we translate is the ROOT session's
// `session.status{idle}` -> `turn-end`. This mirrors the kanban plugin
// (opencodePlugin.ts), which drives card state off the same authoritative edge
// and ignores the coarser `session.idle` (both fire at turn-end; status{idle}
// is the canonical one). busy/retry do not segment the transcript (the agent is
// still working — retry is a provider stall, not a wait on the user), and a
// child/subagent/title/compaction session's idle is ignored (see rootSessionId)
// — the opencode analogue of Claude's gated Stop.

interface TextState {
  emittedLen: number;
}

interface ToolState {
  toolEmitted: boolean;
  resultEmitted: boolean;
}

export class OpencodeTranslator {
  // Keyed by part id: opencode re-sends the same part id as it grows.
  private text = new Map<string, TextState>();
  private tool = new Map<string, ToolState>();
  // Role per message id, learned from message.updated. opencode streams the
  // USER message's own parts as part.updated too; without this we'd surface the
  // user's prompt as assistant output. The user message.updated is emitted at
  // prompt time, before any part, so the role is known by the time parts arrive.
  private role = new Map<string, "user" | "assistant">();

  // The ROOT opencode session id, supplied by the caller (which already knows
  // it: the adapter/mirror both subscribe AFTER session.create, so the root's
  // session.created has already fired and cannot be learned from the stream).
  // opencode runs subagents and title/compaction sessions as separate CHILD
  // sessions, each its own id, and EACH emits its own status{idle} when its
  // turn ends. Mapping any status{idle} to a turn-end would close the turn the
  // moment a child finishes — while the parent is still working. So only the
  // ROOT session's idle is a real turn boundary. While undefined we still emit
  // turn-end so behavior degrades safely (matching the plugin's
  // `!rootId || sessionID === rootId` fallback).
  constructor(private readonly rootSessionId?: string) {}

  translate(event: Event): DriverEvent[] {
    if (event.type === "session.status") {
      // opencode's authoritative work state. Only a turn-ending idle segments
      // the transcript — busy/retry mean the agent is still working (retry is a
      // provider stall, not a wait). And only the ROOT session's idle is a real
      // turn boundary: a child/subagent going idle must NOT end the parent's
      // turn. session.idle (the coarser edge) is intentionally NOT mapped —
      // status{idle} is the canonical boundary, same as the kanban plugin.
      if (event.properties.status.type !== "idle") return [];
      const sid = event.properties.sessionID;
      if (!this.rootSessionId || sid === this.rootSessionId) {
        return [{ kind: "turn-end" }];
      }
      return [];
    }

    if (event.type === "message.updated") {
      const info = event.properties.info;
      this.role.set(info.id, info.role);
      return [];
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      // Only assistant parts become chat output; skip the user's echoed message.
      if (this.role.get(part.messageID) === "user") return [];
      if (part.type === "text") {
        return this.translateText(part);
      }
      if (part.type === "tool") {
        return this.translateTool(part);
      }
    }

    return [];
  }

  private translateText(part: {
    id: string;
    messageID: string;
    text: string;
  }): DriverEvent[] {
    const prev = this.text.get(part.id) ?? { emittedLen: 0 };
    const full = part.text ?? "";
    if (full.length <= prev.emittedLen) {
      // No new text (identical or shorter snapshot); nothing to emit.
      this.text.set(part.id, prev);
      return [];
    }
    const delta = full.slice(prev.emittedLen);
    this.text.set(part.id, { emittedLen: full.length });
    return [{ kind: "text", messageId: part.messageID, text: delta }];
  }

  private translateTool(part: {
    id: string;
    messageID: string;
    callID: string;
    tool: string;
    state: { status: string; input?: unknown; output?: string; error?: string };
  }): DriverEvent[] {
    const st = this.tool.get(part.id) ?? { toolEmitted: false, resultEmitted: false };
    const out: DriverEvent[] = [];

    if (!st.toolEmitted) {
      out.push({
        kind: "tool",
        messageId: part.messageID,
        toolId: part.callID,
        name: part.tool,
        input: part.state.input ?? {},
      });
      st.toolEmitted = true;
    }

    if (!st.resultEmitted) {
      if (part.state.status === "completed") {
        out.push({
          kind: "tool-result",
          toolId: part.callID,
          output: part.state.output ?? "",
          ok: true,
        });
        st.resultEmitted = true;
      } else if (part.state.status === "error") {
        out.push({
          kind: "tool-result",
          toolId: part.callID,
          output: part.state.error ?? "",
          ok: false,
        });
        st.resultEmitted = true;
      }
    }

    // Keep the per-part state even after the result is emitted: opencode can
    // re-send a terminal (completed/error) snapshot, and the `resultEmitted`
    // flag is what makes re-emission idempotent. (State is tiny per part.)
    this.tool.set(part.id, st);
    return out;
  }
}
