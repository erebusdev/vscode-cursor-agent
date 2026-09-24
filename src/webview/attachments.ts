/**
 * Turns pasted / dropped payloads into composer attachments.
 *
 * Two sources reach the webview:
 *  - `text/uri-list`: drags from VS Code's Explorer, editor tabs and (on some
 *    platforms) the OS. Only the host can resolve those URIs against the
 *    workspace, so they are handed back to it.
 *  - `File` objects: OS drops and clipboard images. The webview sandbox does
 *    not expose their paths, so images become inline image attachments and
 *    small text files are attached by content.
 */
import type { PromptAttachmentInput } from "../shared/protocol";

/** Largest dropped text file attached by content. */
const MAX_TEXT_FILE_BYTES = 200 * 1024;

export function readImageFile(file: File): Promise<PromptAttachmentInput | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) return resolve(null);
      resolve({
        kind: "image",
        label: file.name || `image.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`,
        data: url.slice(comma + 1),
        mimeType: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}

function readTextFile(file: File): Promise<PromptAttachmentInput | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      // A NUL byte is a good enough binary sniff for "don't paste this into a prompt".
      if (text.includes("\u0000")) return resolve(null);
      resolve({ kind: "file", label: file.name, text });
    };
    reader.readAsText(file);
  });
}

export interface DroppedPayload {
  /** Attachments the webview could build on its own. */
  readonly attachments: PromptAttachmentInput[];
  /** URIs for the host to resolve into file / image attachments. */
  readonly uris: string[];
  /** Files that could not be attached (binary, too large). */
  readonly skipped: string[];
}

export function uriListFrom(dt: DataTransfer): string[] {
  const raw = dt.getData("text/uri-list");
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function hasDroppable(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

export async function payloadFromDataTransfer(dt: DataTransfer): Promise<DroppedPayload> {
  const uris = uriListFrom(dt);
  const attachments: PromptAttachmentInput[] = [];
  const skipped: string[] = [];
  // When URIs are present they describe the same items as `files` (VS Code sets both for
  // editor tabs); the host resolves URIs with full fidelity, so prefer them.
  if (uris.length === 0) {
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith("image/")) {
        const a = await readImageFile(file);
        if (a) attachments.push(a);
        else skipped.push(file.name);
      } else if (file.size <= MAX_TEXT_FILE_BYTES) {
        const a = await readTextFile(file);
        if (a) attachments.push(a);
        else skipped.push(file.name);
      } else {
        skipped.push(file.name);
      }
    }
  }
  return { attachments, uris, skipped };
}
