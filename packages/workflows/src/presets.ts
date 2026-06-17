/**
 * The built-in workflow library: a curated set of ready-to-apply runbooks the operator
 * can pick from (the Workflows view lists these alongside any saved in the vault). Each
 * extends the default, overriding only its runbook, so they all inherit the default
 * agent/dirty-tree/learning settings. They are authored to be warning-free exemplars;
 * operators are free to author ones that trade off differently.
 */
import { DEFAULT_WORKFLOW } from "./default";
import { resolveSpec } from "./resolve";
import type { WorkflowSpec } from "./types";

const ANALYSIS = resolveSpec({
  name: "analysis",
  description:
    "Iterative data analysis: plan, analyze, render, review-and-iterate, then commit. No PR.",
  steps: [
    { id: "intent", label: "Intent", role: "initial", kind: "prose", prose: "I explain what I want; you ask clarifying questions before starting." },
    { id: "approve-the-plan", label: "Approve the plan", role: "waiting", kind: "gate", gate: "approve", prose: "I confirm the analysis approach." },
    { id: "analyze", label: "Analyze", role: "active", kind: "prose", prose: "Do the analysis, write the .qmd, render it to HTML, and open it for me." },
    { id: "review-the-evidence", label: "Review the evidence", role: "waiting", kind: "gate", gate: "review", prose: "We annotate the HTML together; iterate until I am satisfied." },
    { id: "propose-learnings", label: "Propose learnings", role: "terminal", kind: "primitive", action: "propose-learnings" },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
});

const BUGFIX = resolveSpec({
  name: "bugfix",
  description: "Fast bug fix: reproduce, confirm, fix on a branch with a regression test, review, PR.",
  steps: [
    { id: "reproduce", label: "Reproduce", role: "initial", kind: "prose", prose: "Reproduce the bug and confirm the root cause." },
    { id: "approve-the-plan", label: "Confirm the cause", role: "waiting", kind: "gate", gate: "approve", prose: "I confirm the root cause before you change code." },
    { id: "implement", label: "Fix", role: "active", kind: "prose", prose: "Fix it on your own branch and add a regression test. Render a writeup of the change." },
    { id: "review-the-evidence", label: "Review the fix", role: "waiting", kind: "gate", gate: "review", prose: "I review the writeup and annotate." },
    { id: "propose-learnings", label: "Propose learnings", role: "terminal", kind: "primitive", action: "propose-learnings" },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "open-a-pr", label: "Open a PR", role: "terminal", kind: "primitive", action: "open-pr" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
});

const QUICK_FIX = resolveSpec({
  name: "quick-fix",
  description: "Small change: implement, approve, push to a branch. No PR, no formal review.",
  steps: [
    { id: "implement", label: "Implement", role: "active", kind: "prose", prose: "Make the change on your own branch and commit it." },
    { id: "approve-the-plan", label: "Approve", role: "waiting", kind: "gate", gate: "approve", prose: "I approve the change before you push." },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
});

const RELEASE = resolveSpec({
  name: "release",
  description: "Release: prepare notes, approve, cut the release, review, then push + PR + merge.",
  steps: [
    { id: "prepare", label: "Prepare", role: "initial", kind: "prose", prose: "Draft the release notes and changelog." },
    { id: "approve-the-plan", label: "Approve the release", role: "waiting", kind: "gate", gate: "approve", prose: "I approve the release plan." },
    { id: "implement", label: "Cut the release", role: "active", kind: "prose", prose: "Bump the version, finalize the changelog, on your own branch." },
    { id: "review-the-evidence", label: "Review the release", role: "waiting", kind: "gate", gate: "review", prose: "I review the release writeup before it merges." },
    { id: "journal", label: "Journal", role: "terminal", kind: "primitive", action: "journal" },
    { id: "push", label: "Push", role: "terminal", kind: "primitive", action: "push" },
    { id: "open-a-pr", label: "Open a PR", role: "terminal", kind: "primitive", action: "open-pr" },
    { id: "merge", label: "Merge", role: "terminal", kind: "primitive", action: "merge" },
    { id: "reap", label: "Reap", role: "terminal", kind: "primitive", action: "reap" },
  ],
});

/** The built-in library, default first. */
export const PRESET_WORKFLOWS: WorkflowSpec[] = [
  DEFAULT_WORKFLOW,
  ANALYSIS,
  BUGFIX,
  QUICK_FIX,
  RELEASE,
];
