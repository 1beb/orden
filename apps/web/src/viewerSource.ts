import { contentHash, type Source } from "@orden/annotation-core";

// The WADM Source for an owned repo file currently open in a viewer.
//
// For text files (code/markdown/html source) pass the file's text so the
// contentHash reflects its bytes and drift is detectable. For images (binary,
// loaded via /repo-file/ rather than read as text) there is no text to hash;
// pass the path as the content so the source still has a stable hash —
// `sourceHash` keys on vaultPath regardless, and region anchors don't depend on
// byte-level drift. A true binary contentHash is deferred (see the Phase-1
// carry-forward note in the annotation design).
export async function fileSource(path: string, content: string, title?: string): Promise<Source> {
  return { kind: "file", vaultPath: path, contentHash: await contentHash(content), title };
}
