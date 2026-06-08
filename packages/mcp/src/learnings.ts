import type { VaultStore, Learning, LearningStatus } from "@orden/host-api";

// The Learning vault model is canonically declared in @orden/host-api; re-export
// it here so existing consumers of @orden/mcp's barrel keep resolving these names.
export type { Learning, LearningType, LearningStatus, LearningComment } from "@orden/host-api";

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

// Read-modify-write, not atomic. Safe under orden's single-writer-per-record
// assumption; if the web and a delivering agent ever race on one learning, last
// write wins. `at` is epoch ms, passed in for deterministic tests.
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
