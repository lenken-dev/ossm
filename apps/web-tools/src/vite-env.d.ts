/// <reference types="vite/client" />

/** Document Picture-in-Picture: an always-on-top window for any content (Chrome 116+). */
interface Window {
  documentPictureInPicture?: {
    requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  };
}
