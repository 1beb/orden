import type { VaultStore } from "@orden/host-api";

/**
 * A proposed artifact change captured during a session — a README/ADR/AGENTS
 * tweak or a new skill — surfaced for the user to review, edit, and accept or
 * reject. One record per proposed change, persisted in the vault ns
 * `"learnings"` keyed by `id`.
 */

export type LearningType = "readme" | "adr" | "agents" | "skill";
export type LearningStatus = "pending" | "accepted" | "rejected";

export interface Learning {
  id: string;
  cardId: string;
  sessionId?: string;
  projectId: string;
  type: LearningType;
  title: string;
  /** Per-learning context shown at the bottom of the review step. */
  recap: string;
  /** Project-relative file to edit/create. */
  targetPath: string;
  op: "edit" | "create";
  /** FULL file content to write on accept (not a patch). */
  proposedContent: string;
  /** Current file content for diff display (edit only). */
  baseContent?: string;
  status: LearningStatus;
  comments?: { at: number; text: string }[];
  createdAt: number;
}

const NS = "learnings";

export async function putLearning(vault: VaultStore, learning: Learning): Promise<void> {
  await vault.set(NS, learning.id, learning);
}

export async function getLearning(vault: VaultStore, id: string): Promise<Learning | null> {
  return vault.get<Learning>(NS, id);
}

export async function listLearnings(vault: VaultStore): Promise<Learning[]> {
  const ids = await vault.list(NS);
  const all = await Promise.all(ids.map((id) => vault.get<Learning>(NS, id)));
  return all.filter((l): l is Learning => !!l);
}

export async function listLearningsForCard(
  vault: VaultStore,
  cardId: string,
): Promise<Learning[]> {
  return (await listLearnings(vault)).filter((l) => l.cardId === cardId);
}

export async function setLearningStatus(
  vault: VaultStore,
  id: string,
  status: LearningStatus,
): Promise<Learning | null> {
  const learning = await getLearning(vault, id);
  if (!learning) return null;
  const updated: Learning = { ...learning, status };
  await putLearning(vault, updated);
  return updated;
}

export async function addLearningComment(
  vault: VaultStore,
  id: string,
  text: string,
  at: number,
): Promise<Learning | null> {
  const learning = await getLearning(vault, id);
  if (!learning) return null;
  const updated: Learning = {
    ...learning,
    comments: [...(learning.comments ?? []), { at, text }],
  };
  await putLearning(vault, updated);
  return updated;
}
