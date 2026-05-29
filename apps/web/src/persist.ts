import type { Annotation } from "@orden/annotation-core";

export interface PersistedDoc {
  markdown: string;
  records: Annotation[];
}

function storageKey(docKey: string): string {
  return `orden:doc:${docKey}`;
}

export function saveState(
  docKey: string,
  markdown: string,
  records: Annotation[],
): void {
  const payload: PersistedDoc = { markdown, records };
  localStorage.setItem(storageKey(docKey), JSON.stringify(payload));
}

export function loadState(docKey: string): PersistedDoc | null {
  const raw = localStorage.getItem(storageKey(docKey));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PersistedDoc;
  } catch {
    return null;
  }
}

export function clearState(docKey: string): void {
  localStorage.removeItem(storageKey(docKey));
}
