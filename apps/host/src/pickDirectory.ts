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

// A native GUI dialog needs more than the binary: it needs a reachable display.
// The host is frequently launched headless over SSH (XDG_SESSION_TYPE=tty, no
// DISPLAY/WAYLAND_DISPLAY), where zenity/kdialog exit non-zero before drawing
// anything. Without this check the capability reads true, the modal renders a
// "Browse…" button, and every click silently fails (the error is swallowed as a
// cancel). Requiring a display keeps the button off headless hosts so the user
// just types the path. (A remote host's dialog would also pop on the server's
// screen, not the user's — equally unusable; typing the path is correct there.)
function displayAvailable(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** True when a native directory dialog can actually be shown on this host. */
export function hasDirectoryPicker(): boolean {
  return displayAvailable() && detectPicker() !== null;
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
  // No display => no dialog can render; bail rather than spawn a doomed process
  // whose non-zero exit we'd swallow as a cancel (mirrors hasDirectoryPicker).
  if (!tool || !displayAvailable()) return Promise.resolve(null);
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
