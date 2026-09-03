// Live TCP reachability probe used by `miro setup` to show "SSH available" before ever
// attempting to authenticate (plan §10's discovery screen). No credentials involved - just
// whether something is listening on the port.

export async function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          socket.end();
          finish(true);
        },
        data() {},
        close() {},
        error() {
          clearTimeout(timer);
          finish(false);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export function probeSsh(host: string, port = 22, timeoutMs = 1500): Promise<boolean> {
  return probePort(host, port, timeoutMs);
}
