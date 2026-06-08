// Focus-guard predicate for the learnings review stepper. True when the user is
// mid-typing in the comment input inside #view-learnings. The change-feed re-render
// path (an EXTERNAL update, e.g. the agent's revision flipping revising→pending)
// uses this to skip rebuilding the stepper DOM while a comment is in progress —
// rebuilding would drop the in-progress text and focus. User-initiated re-renders
// (accept / reject / comment) are NOT guarded; those should advance the stepper.
export function learningsCommentFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return false;
  return active.closest("#view-learnings .comment-row") !== null;
}
