/**
 * `native-preview` — viewers for every file type a browser can show by itself.
 *
 * Five viewers offered on the `viewers` port (`lm/attachments.viewer`), each a plain
 * element around the object URL `attachments` hands over: `<img>`, `<video>`, `<audio>`,
 * an `<iframe>` for PDF (the browser's own PDF viewer) and a `<pre>` for plain text.
 * Nothing is decoded or parsed here, so what shows is whatever the browser supports: a
 * codec it lacks gets the "cannot play" message, not a broken player.
 *
 * Which viewer shows a type is the wiring's seat order on the host: a plugin seated
 * before this one takes the types it claims over, and the user can switch back per type.
 *
 * **SVG is not here** (SPEC §3.6: a stored-XSS vector), and neither is HTML: those are
 * files a browser would *run*, not preview.
 *
 * **PDF needs `frame-src blob:`** in the app's CSP (`statics.rs`, `shell.rs`). The
 * frame gets a URL for the bytes re-typed as `application/pdf`, so whatever the file
 * claims to be, the browser only ever opens it with its PDF viewer. A browser without
 * one (Android's WebView) says so through `navigator.pdfViewerEnabled`, and gets a
 * message instead of an empty frame.
 */

import type { Kernel } from "@kernel";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { AttachmentViewer, AttachmentViewerProps } from "@protocols/lm/attachments.viewer";

/** Beyond this, a text file shows its start and says so. */
const MAX_TEXT_BYTES = 256 * 1024;

const FRAME =
  "nativepreview:block nativepreview:max-w-full nativepreview:rounded-lg nativepreview:border nativepreview:border-border nativepreview:bg-bg-subtle";

function Image({ file, url, placement }: AttachmentViewerProps): ReactNode {
  return (
    <img
      className={`nativepreview:h-auto nativepreview:max-w-full nativepreview:rounded ${
        placement === "page" ? "nativepreview:mx-auto nativepreview:block nativepreview:max-h-[70vh]" : ""
      }`}
      src={url}
      alt={file.name}
      loading="lazy"
    />
  );
}

function Unplayable({ file, what }: { readonly file: AttachmentViewerProps["file"]; readonly what: string }): ReactNode {
  return (
    <span className="nativepreview:inline-block nativepreview:rounded-lg nativepreview:border nativepreview:border-dashed nativepreview:border-border-strong nativepreview:bg-bg-subtle nativepreview:px-3 nativepreview:py-2 nativepreview:text-sm nativepreview:text-text-muted">
      {file.name}: this browser cannot {what} this file.
    </span>
  );
}

function Video({ file, url, placement }: AttachmentViewerProps): ReactNode {
  const [failed, setFailed] = useState(false);
  if (failed) return <Unplayable file={file} what="play" />;
  return (
    <video
      className={`${FRAME} nativepreview:w-full ${placement === "page" ? "nativepreview:max-h-[75vh]" : "nativepreview:max-h-[60vh]"}`}
      src={url}
      controls
      playsInline
      preload="metadata"
      aria-label={file.name}
      onError={() => setFailed(true)}
    />
  );
}

function Audio({ file, url }: AttachmentViewerProps): ReactNode {
  const [failed, setFailed] = useState(false);
  if (failed) return <Unplayable file={file} what="play" />;
  return (
    <audio
      className="nativepreview:block nativepreview:w-full nativepreview:max-w-[48ch]"
      src={url}
      controls
      preload="metadata"
      aria-label={file.name}
      onError={() => setFailed(true)}
    />
  );
}

function Pdf({ file, blob, placement }: AttachmentViewerProps): ReactNode {
  // Re-typed, whatever the server said: the frame must only ever get the PDF viewer.
  const url = useMemo(() => URL.createObjectURL(new Blob([blob], { type: "application/pdf" })), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (typeof navigator !== "undefined" && navigator.pdfViewerEnabled === false) {
    return <Unplayable file={file} what="show" />;
  }
  return (
    <iframe
      className={`${FRAME} nativepreview:w-full ${placement === "page" ? "nativepreview:h-[75vh]" : "nativepreview:h-[60vh]"}`}
      src={url}
      title={file.name}
    />
  );
}

function Text({ file, blob, placement }: AttachmentViewerProps): ReactNode {
  const [text, setText] = useState<string | undefined>(undefined);
  const cut = blob.size > MAX_TEXT_BYTES;
  useEffect(() => {
    let live = true;
    void blob
      .slice(0, MAX_TEXT_BYTES)
      .text()
      .then((value) => {
        if (live) setText(value);
      });
    return () => {
      live = false;
    };
  }, [blob]);

  return (
    <span className="nativepreview:flex nativepreview:w-full nativepreview:flex-col nativepreview:gap-1">
      {/* A block `<span>`, not a `<pre>`: an inline embed sits inside a paragraph. */}
      <span
        className={`nativepreview:m-0 nativepreview:block nativepreview:overflow-auto nativepreview:whitespace-pre-wrap nativepreview:break-words nativepreview:rounded nativepreview:border nativepreview:border-border nativepreview:bg-bg-subtle nativepreview:p-2 nativepreview:font-mono nativepreview:text-sm nativepreview:leading-[1.5] nativepreview:text-text ${
          placement === "page" ? "nativepreview:max-h-[75vh]" : "nativepreview:max-h-[40vh]"
        }`}
        aria-label={file.name}
        aria-busy={text === undefined}
      >
        {text ?? "…"}
      </span>
      {cut ? (
        <span className="nativepreview:text-sm nativepreview:text-text-muted">
          Showing the first 256 KB. Download the file for the rest.
        </span>
      ) : null}
    </span>
  );
}

const VIEWERS: readonly AttachmentViewer[] = [
  {
    id: "native-preview.image",
    label: "Browser: image",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "apng"],
    component: Image,
  },
  {
    id: "native-preview.video",
    label: "Browser: video player",
    extensions: ["mp4", "m4v", "webm", "ogv", "mov"],
    component: Video,
  },
  {
    id: "native-preview.audio",
    label: "Browser: audio player",
    extensions: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"],
    component: Audio,
  },
  {
    id: "native-preview.pdf",
    label: "Browser: PDF viewer",
    extensions: ["pdf"],
    component: Pdf,
  },
  {
    id: "native-preview.text",
    label: "Browser: plain text",
    extensions: ["txt", "text", "log", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini"],
    component: Text,
  },
];

export default function activate(kernel: Kernel): void {
  // One port, five viewers: they stay together, in this order, on every host wired to it.
  kernel.ports.offer<AttachmentViewer>("viewers", VIEWERS);
}
