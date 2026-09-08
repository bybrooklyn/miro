/** Is something actually listening on this unix socket path, or is it a file a crash left behind?
 *
 * The difference matters at boot: a stale socket must be unlinked, but a live one must not. A second
 * mirod that unlinks a live socket and listens on its own leaves the socket dead when it exits, while
 * the unit still reports active and nothing can connect. Found live on a fresh box, where an older
 * release's `mirod status` (a subcommand that tree did not know) booted a second daemon and took the
 * socket from the running one.
 *
 * Connecting is the only honest test - the file existing says nothing, and checking a pidfile would be
 * a second source of truth to keep in sync. */
export async function isSocketLive(path: string, timeoutMs = 1500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open: (s) => {
          clearTimeout(timer);
          s.end();
          done(true);
        },
        data: () => {},
        error: () => {
          clearTimeout(timer);
          done(false);
        },
        close: () => {},
      },
    }).catch(() => {
      clearTimeout(timer);
      done(false);
    });
  });
}
