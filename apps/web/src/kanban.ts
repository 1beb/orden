import { renderBoard, needsActionCount, type Card } from "@orden/outliner";

// Mock cards spanning the lifecycle (real cards become Session projections later).
const MOCK_CARDS: Card[] = [
  { id: "c1", title: "Draft Q3 churn brief", state: "backlog" },
  { id: "c2", title: "Wire SFTP read path", state: "todo" },
  { id: "c3", title: "Feature pipeline refactor", state: "in-progress" },
  { id: "c4", title: "Calibration on low tier", state: "in-progress" },
  { id: "c5", title: "Need API key for eval", state: "blocked" },
  { id: "c6", title: "Churn model review", state: "ready" },
  { id: "c7", title: "Stall detector", state: "ready" },
  { id: "c8", title: "Nightly export", state: "complete" },
  { id: "c9", title: "Transcript adapter crashed", state: "broken" },
];

export function mountKanban(container: HTMLElement): { needsAction: number } {
  renderBoard(container, MOCK_CARDS);
  return { needsAction: needsActionCount(MOCK_CARDS) };
}
