/** Megabytes for people: "0.4 MB", "9.8 MB", "126 MB". */
export const formatMB = (bytes: number) =>
  bytes < 1e6 ? `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`
