/** "Chrome on Windows" for the sessions list. Deliberately tiny — it only needs to be recognisable, not exact. */
export const describeDevice = (
  userAgent: string | null | undefined,
): string => {
  if (!userAgent) {
    return 'Unknown device';
  }

  // Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\/|Opera/.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : /curl\//i.test(userAgent)
              ? 'curl'
              : null;

  // iOS user agents also contain "like Mac OS X", so check iPhone/iPad before macOS.
  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /Linux|X11/.test(userAgent)
            ? 'Linux'
            : null;

  if (browser && os) {
    return `${browser} on ${os}`;
  }

  return browser ?? os ?? 'Unknown device';
};
