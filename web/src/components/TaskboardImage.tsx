import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { isPaseoEmbeddedHost, resolveTaskboardUrl } from "../api";

function paseoAttachmentContentPath(src: string | undefined): string | null {
  if (!src || !isPaseoEmbeddedHost()) return null;
  try {
    const baseUrl = new URL(document.baseURI);
    const imageUrl = new URL(src, baseUrl);
    if (imageUrl.origin !== baseUrl.origin) return null;
    if (!/^\/api\/attachments\/[^/?#]+\/content$/.test(imageUrl.pathname)) return null;
    return `${imageUrl.pathname}${imageUrl.search}`;
  } catch {
    return null;
  }
}

export function TaskboardImage({ src, ...props }: ComponentPropsWithoutRef<"img">) {
  const attachmentPath = paseoAttachmentContentPath(src);
  const [resolvedSource, setResolvedSource] = useState<{
    attachmentPath: string;
    objectUrl: string;
  } | null>(null);

  useEffect(() => {
    if (!attachmentPath) return undefined;
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;

    void fetch(resolveTaskboardUrl(attachmentPath), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Attachment image request failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedSource({ attachmentPath, objectUrl });
      })
      .catch(() => {});

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentPath]);

  const resolvedSrc = attachmentPath
    ? resolvedSource?.attachmentPath === attachmentPath
      ? resolvedSource.objectUrl
      : undefined
    : src;

  return <img {...props} src={resolvedSrc} />;
}
