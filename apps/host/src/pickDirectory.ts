// Native directory picker for the host machine. The web app can't produce a
// real filesystem path (browsers deliberately hide it), so the "Browse…" button
// in the add/edit-project modal calls through to the host, which pops a native
// OS directory dialog and returns the chosen absolute path.
//
// NOTE: the dialog opens on the HOST machine's display. For the local nodehost
// (host + browser on one machine) that's exactly right; a remote host would pop
// the dialog on the server, which is nonsensical — gate accordingly when remote
// hosts land.
import { spawnSync, execFile } from "node:child_process";

type Picker = "zenity" | "kdialog";

// Resolve which picker tool is on PATH, once. `null` means none — the host then
// reports the pickDirectory capability as false so the UI hides the button.
let cached: Picker | null | undefined;
function detectPicker(): Picker | null {
  if (cached !== undefined) return cached;
  for (const tool of ["zenity", "kdialog"] as const) {
    const r = spawnSync("which", [tool], { stdio: "ignore" });
    if (r.status === 0) {
      cached = tool;
      return tool;
    }
  }
  cached = null;
  return null;
}

/** True when a native directory dialog is available on this host. */
export function hasDirectoryPicker(): boolean {
  return detectPicker() !== null;
}

/**
 * Open a native directory chooser and resolve to the selected absolute path, or
 * null if the user cancels (or no picker is installed). `startPath` seeds the
 * dialog's initial location when given.
 */
export function pickDirectory(opts?: {
  title?: string;
  startPath?: string;
}): Promise<string | null> {
  const tool = detectPicker();
  if (!tool) return Promise.resolve(null);
  const title = opts?.title ?? "Choose project folder";

  const args =
    tool === "zenity"
      ? [
          "--file-selection",
          "--directory",
          `--title=${title}`,
          // A trailing slash hints zenity to open inside the folder.
          ...(opts?.startPath ? [`--filename=${opts.startPath.replace(/\/?$/, "/")}`] : []),
        ]
      : [
          // kdialog --getexistingdirectory <startDir> <title>
          "--getexistingdirectory",
          opts?.startPath || process.env.HOME || ".",
          "--title",
          title,
        ];

  return new Promise((resolve) => {
    execFile(tool, args, { timeout: 5 * 60_000 }, (err, stdout) => {
      // Non-zero exit = the user cancelled (or an error). Either way, no path.
      if (err) {
        resolve(null);
        return;
      }
      const path = stdout.toString().trim();
      resolve(path || null);
    });
  });
}
