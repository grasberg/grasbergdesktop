/**
 * Null-byte sniff over the head of a buffer — a cheap binary detector shared
 * by the attachment reader, the project-file tools and the repo map. (The
 * diff module's isProbablyBinary keeps its own 8000-byte window; its behavior
 * is pinned by tests.)
 */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}
