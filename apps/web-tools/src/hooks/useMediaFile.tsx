import { useEffect, useRef, useState } from "react";

/**
 * A video or audio file the user opens, and its object URL while open;
 * `onChange` runs with the new file, or null on close, before it takes over.
 * Render `input`, the hidden file input `choose` opens.
 */
export function useMediaFile(onChange: (file: File | null) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  /** An audio file plays in a bar instead of the video area. */
  const isAudio = !!file?.type.startsWith("audio/");

  useEffect(() => {
    setUrl(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const change = (next: File | null) => {
    onChange(next);
    setFile(next);
  };
  /** Ask for a media file to open. */
  const choose = () => inputRef.current?.click();
  const close = () => change(null);
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="video/*,audio/*"
      hidden
      onChange={(e) => {
        const next = e.target.files?.[0];
        if (next) change(next);
        e.target.value = "";
      }}
    />
  );

  return { file, url, isAudio, choose, close, input };
}
