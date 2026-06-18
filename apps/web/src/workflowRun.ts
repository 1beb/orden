// Workflow run-states: the durable progress of a runbook-engine-driven card,
// backed by the host vault (ns "workflow-run", one key per card id). The host's
// runbook runner writes these; the web reads them to surface gate-approval
// buttons. Accessors stay synchronous over a cache hydrated at boot; the vault
// change router re-hydrates on any write so the view stays live.
import type { Host } from "@orden/host-api";
import type { RunState } from "@orden/workflows";

const RUN_NS = "workflow-run";
const SIGNAL_NS = "workflow-signal";

let host: Host | null = null;
let cache: Map<string, RunState> = new Map();

export async function hydrateWorkflowRuns(h: Host): Promise<void> {
  host = h;
  await refreshWorkflowRuns();
}

/** Re-read every run-state from the vault (the vault-change router calls this). */
export async function refreshWorkflowRuns(): Promise<void> {
  if (!host) return;
  const ids = await host.vault.list(RUN_NS);
  const entries = await Promise.all(
    ids.map(async (id) => {
      const rs = await host!.vault.get<RunState>(RUN_NS, id);
      return [id, rs] as const;
    }),
  );
  cache = new Map(entries.filter(([, rs]) => rs !== null) as [string, RunState][]);
}

/** The run-state for a card, or undefined when the card isn't engine-driven. */
export function getRunState(cardId: string): RunState | undefined {
  return cache.get(cardId);
}

/**
 * Send a gate/step signal to a card's runbook (approve/reject a gate, or
 * complete a prose step). Writes to the workflow-signal namespace; the host's
 * serve.ts reactor routes it to the runbook runner.
 */
export function sendGateSignal(
  cardId: string,
  signal: "approve" | "reject" | "complete",
): void {
  if (host) void host.vault.set(SIGNAL_NS, cardId, { signal });
}
