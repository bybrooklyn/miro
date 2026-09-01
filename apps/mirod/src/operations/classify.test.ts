import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync, chmodSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, tokenize, splitSegments, type CommandClass } from "./classify";

// The bypass catalogue from PLAN.md §5.7, as executable spec. Every entry there has a case here;
// the classifier is not done until every case passes. Real filesystem for binary resolution
// (a temp bin dir with real executables and symlinks), no mocks — the resolver is injected the
// same way the daemon injects it, pointed at a directory this test controls.

let binDir: string;
let untrustedDir: string;

function fakeExecutable(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  // realpath: on macOS tmpdir() is /var/... which resolves to /private/var/... — the classifier
  // compares realpaths against the trusted list, so the fixture must be a realpath too.
  binDir = realpathSync(mkdtempSync(join(tmpdir(), "classify-bin-")));
  untrustedDir = realpathSync(mkdtempSync(join(tmpdir(), "classify-untrusted-")));
  for (const n of ["ls", "cat", "rm", "ip", "docker", "systemctl", "grep", "find", "sed", "curl", "git", "apt", "dig", "ss", "tail", "python3", "bash", "sqlite3", "tee", "dd", "echo", "jq", "env", "sudo", "xargs", "nsenter", "busybox", "nice", "timeout", "tcpdump", "iptables", "nft", "ufw", "passwd", "kill", "pkill", "truncate", "cp", "mv", "tar", "rsync", "crontab", "chmod", "chown", "sleep", "yes", "watch", "wget", "perl", "node", "awk", "stat", "df", "journalctl", "nmcli", "apt-get", "dpkg", "mount", "umount", "sysctl", "pip", "ln", "mkdir", "touch", "wg", "ssh", "npm", "printenv", "top", "less", "apt-cache", "wc"]) {
    fakeExecutable(binDir, n);
  }
  // A symlink named `ls` that is really `rm` — the PATH-shadow bypass.
  mkdirSync(join(untrustedDir, "shadow"));
  symlinkSync(join(binDir, "rm"), join(untrustedDir, "shadow", "ls"));
  // A binary outside the trusted directories.
  fakeExecutable(untrustedDir, "ls");
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(untrustedDir, { recursive: true, force: true });
});

function resolve(name: string): string | null {
  const p = name.includes("/") ? name : join(binDir, name);
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function cls(command: string): CommandClass {
  return classifyCommand(command, { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" }).class;
}

function expectAll(expected: CommandClass, commands: string[]) {
  for (const c of commands) {
    const got = classifyCommand(c, { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" });
    expect(`${c} => ${got.class} (${got.reasons.join("; ")})`).toBe(`${c} => ${expected} (${got.reasons.join("; ")})`);
  }
}

describe("tokenizer", () => {
  test("quoting tricks canonicalise to the literal word", () => {
    for (const c of ["r'm' x", '"r"m x', "r\\m x", "$'rm' x", "'rm' x", '"rm" x']) {
      const segs = splitSegments(tokenize(c));
      expect(segs[0].argv[0]).toBe("rm");
    }
  });
  test("compound operators split segments", () => {
    const segs = splitSegments(tokenize("ls; cat x && echo y || true | grep z\ntail f"));
    expect(segs.map((s) => s.argv[0])).toEqual(["ls", "cat", "echo", "true", "grep", "tail"]);
  });
  test("redirects are captured with fd and target, & marks background", () => {
    const segs = splitSegments(tokenize("cmd 2>/dev/null >out.txt 2>&1 &"));
    expect(segs[0].redirects).toEqual([
      { fd: 2, op: ">", target: "/dev/null" },
      { fd: null, op: ">", target: "out.txt" },
      { fd: 2, op: ">&", target: "1" },
    ]);
    expect(segs[0].background).toBe(true);
  });
  test("expansion is flagged, not evaluated", () => {
    for (const c of ["$RM x", "$(echo rm) x", "`which rm` x", "echo $HOME", 'echo "$X"', "cat <(ls)"]) {
      expect(splitSegments(tokenize(c))[0].hasExpansion).toBe(true);
    }
    expect(splitSegments(tokenize("echo '$HOME'"))[0].hasExpansion).toBe(false);
  });
  test("unterminated quotes are a parse error → forbidden", () => {
    expect(cls("echo 'oops")).toBe("forbidden");
    expect(classifyCommand("echo 'oops").parseError).toBeDefined();
  });
});

describe("read", () => {
  test("plain readers and read-only subcommands", () => {
    expectAll("read", [
      "ls -la /etc",
      "cat /etc/fstab",
      "grep -r foo /var/log",
      "tail -n 50 /var/log/syslog",
      "ip route show",
      "ip -n ns1 route",
      "ip addr",
      "ip link",
      "ss -tlnp",
      "dig +short example.com",
      "docker ps -a",
      "docker inspect jellyfin",
      "docker logs --tail 100 jellyfin",
      "docker images",
      "docker network ls",
      "docker volume inspect media",
      "docker compose ps",
      "docker stats --no-stream",
      "systemctl status docker",
      "systemctl list-units --type=service",
      "systemctl is-active ssh",
      "systemctl cat jellyfin",
      "find /srv/media -name '*.mkv'",
      "sed -n '1,10p' /etc/hosts",
      "awk '{print $1}' /etc/passwd",
      "curl -s http://127.0.0.1:8096/System/Info/Public",
      "curl -sI https://example.com",
      "wget -qO- http://127.0.0.1:8096/health",
      "git status",
      "git log --oneline -20",
      "git diff",
      "apt list --installed",
      "apt-cache policy docker.io",
      "dpkg -l | grep docker",
      "sqlite3 /opt/app/db.sqlite 'SELECT count(*) FROM users'",
      "iptables -L -n",
      "nft list ruleset",
      "ufw status verbose",
      "tcpdump -i eth0 -c 100 port 8096",
      "journalctl -u docker --since today",
      "mount",
      "df -h",
      "stat /srv/media",
      "kill -0 1234",
      "crontab -l",
      "printenv PATH",
      "sysctl net.ipv4.ip_forward",
      "wg show",
      "nmcli device status",
      "echo hello",
      "sleep 1",
      "top -bn1",
      "docker exec jellyfin cat /config/system.xml",
      "sudo cat /etc/fstab",
      "env FOO=bar ls",
      "nice -n 10 ls",
      "timeout 5 ls",
      "nsenter -t 1234 -n ip route",
      "cat /etc/hosts 2>/dev/null",
      "ls /tmp 2>&1",
      "ls | grep x | wc -l",
    ]);
  });
});

describe("mutate", () => {
  test("ordinary state changes", () => {
    expectAll("mutate", [
      "mkdir -p /srv/media/movies",
      "touch /tmp/x",
      "ln -s /a /b",
      "apt install jellyfin",
      "apt-get update",
      "docker run -d --name jellyfin -p 8096:8096 jellyfin/jellyfin",
      "docker compose up -d",
      "docker start jellyfin",
      "docker stop jellyfin",
      "docker pull jellyfin/jellyfin",
      "docker network rm mynet",
      "systemctl restart jellyfin",
      "systemctl enable jellyfin",
      "systemctl stop jellyfin",
      "sed -i 's/a/b/' /opt/app/config.ini",
      "curl -X POST http://127.0.0.1:8096/Startup/Complete",
      "curl -o /tmp/x.tar.gz https://example.com/x.tar.gz",
      "wget https://example.com/file",
      "git commit -m x",
      "git push",
      "sqlite3 db.sqlite 'INSERT INTO t VALUES (1)'",
      "tee /opt/app/conf",
      "echo x > /tmp/out",
      "cat a > /tmp/b",
      "tar xzf x.tgz",
      "gzip file",
      "crontab /tmp/newcron",
      "chmod 644 /opt/app/x",
      "chown miro:miro /srv/media",
      "kill 1234",
      "pkill jellyfin",
      "python3 -c 'print(1)'",
      "bash -c 'ls -la'",
      "sh -c 'mkdir /tmp/x'",
      "perl -e 'print 1'",
      "node -e 'console.log(1)'",
      "python3 script.py",
      "bash ./install.sh",
      "unknowncommand --flag",
      "ls &",
      "ls $DIR",
      "$(echo ls)",
      "l? /tmp",
      "docker exec jellyfin touch /config/x",
      "sudo apt install x",
      "xargs mkdir",
      "tcpdump -i eth0 -w /tmp/cap.pcap",
      "swapoff -a",
      "mount /dev/vdb1 /mnt",
      "npm install -g x",
      "pip install x",
    ]);
  });
  test("a binary outside the trusted directories is never read", () => {
    const got = classifyCommand(`${untrustedDir}/ls`, { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" });
    expect(got.class).toBe("mutate");
    expect(got.reasons[0]).toContain("outside trusted directories");
  });
});

describe("destructive", () => {
  test("data loss or hard-to-reverse changes", () => {
    expectAll("destructive", [
      "docker rm jellyfin",
      "docker rmi jellyfin/jellyfin",
      "docker volume rm media",
      "docker volume prune",
      "docker system prune -a --volumes",
      "docker compose down -v",
      "docker compose rm",
      "docker run --privileged alpine",
      "docker run -v /:/host alpine ls",
      "docker run --pid=host alpine",
      "docker run -v /var/run/docker.sock:/var/run/docker.sock alpine",
      "docker run --cap-add=SYS_ADMIN alpine",
      "git clean -fdx",
      "git reset --hard HEAD~1",
      "git checkout -- .",
      "git push --force",
      "git branch -D feature",
      "git stash drop",
      "apt remove jellyfin",
      "apt purge jellyfin",
      "apt autoremove",
      "apt upgrade",
      "apt full-upgrade",
      "dpkg -P jellyfin",
      "sqlite3 db.sqlite 'DELETE FROM users'",
      "sqlite3 db.sqlite 'DROP TABLE users'",
      "psql -c 'TRUNCATE t'",
      "dd if=/dev/zero of=/tmp/file bs=1M count=10",
      "chmod -R 755 /srv/media",
      "chown -R miro /srv/media",
      "python3 -c 'import shutil; shutil.rmtree(\"/srv\")'",
      "python3 -c 'import os; os.remove(\"/x\")'",
      "perl -e 'unlink \"/x\"'",
      "node -e 'require(\"fs\").rmSync(\"/x\", {recursive:true})'",
      "pip uninstall x",
      "npm uninstall -g x",
      "chattr +i /x",
    ]);
  });
});

describe("lifeline", () => {
  test("lockout, network, and Miro-self paths", () => {
    expectAll("lifeline", [
      "iptables -F",
      "iptables -A INPUT -p tcp --dport 22 -j DROP",
      "nft flush ruleset",
      "nft add rule inet filter input drop",
      "ufw enable",
      "ufw deny 22",
      "ip link set eth0 down",
      "ip route add default via 10.0.0.1",
      "ip route del default",
      "ip addr flush dev eth0",
      "ifdown eth0",
      "nmcli connection down eth0",
      "wg-quick down wg0",
      "systemctl stop ssh",
      "systemctl stop docker",
      "systemctl disable sshd",
      "systemctl mask mirod",
      "systemctl stop systemd-networkd",
      "pkill sshd",
      "killall dockerd",
      "pkill mirod",
      "passwd -l miro",
      "usermod -L miro",
      "userdel miro",
      "chage -E 0 miro",
      "sed -i 's/PermitRootLogin yes/no/' /etc/ssh/sshd_config",
      "tee /etc/ssh/sshd_config",
      "echo x > /etc/ssh/sshd_config",
      "echo 'key' >> /home/miro/.ssh/authorized_keys",
      "echo x >> ~/.ssh/authorized_keys",
      "touch /etc/sudoers.d/miro",
      "cp /tmp/x /etc/fstab",
      "cp /tmp/x /etc/passwd",
      "cp /tmp/x /etc/resolv.conf",
      "cp /tmp/x /etc/netplan/01.yaml",
      "cp /tmp/x /etc/nftables.conf",
      "cp /tmp/x /boot/grub/grub.cfg",
      "touch /home/miro/.miro/x",
      "cp /tmp/x ~/.miro/extensions/jellyfin/tools.ts",
      "sysctl -w net.ipv4.ip_forward=1",
      "umount /srv/media",
      "modprobe -r wireguard",
      "chmod 000 /etc",
      "visudo",
      "chsh -s /bin/false miro",
      "docker exec jellyfin sh -c 'echo x > /etc/ssh/sshd_config'",
      "tailscale down",
    ]);
  });
});

describe("forbidden", () => {
  test("deletion by any name", () => {
    expectAll("forbidden", [
      "rm x",
      "rm -rf /",
      "rm -rf /srv/media",
      "rmdir /x",
      "unlink /x",
      "shred -u /x",
      "find /tmp -delete",
      "find /tmp -name '*.log' -exec rm {} \\;",
      "find /tmp -name '*.log' -exec rm {} +",
      "rsync -a --delete /a/ /b/",
      "tar --remove-files -czf x.tgz dir",
      "truncate -s0 /x",
      "truncate -s 0 /x",
      "cp /dev/null /x",
      "mv /x /dev/null",
      "mv / /tmp",
      "> /x",
      ": > /x",
      "crontab -r",
    ]);
  });
  test("quoting, path, alias, and wrapper bypasses all resolve to rm", () => {
    expectAll("forbidden", [
      "r'm' x",
      '"r"m x',
      "r\\m x",
      "$'rm' x",
      `${"/bin"}/rm x`,
      "/usr/bin/rm x",
      "./rm x",
      "\\rm x",
      "command rm x",
      "busybox rm x",
      "env rm x",
      "env -i FOO=1 rm x",
      "nice rm x",
      "nice -n 5 rm x",
      "timeout 5 rm x",
      "nohup rm x",
      "setsid rm x",
      "stdbuf -oL rm x",
      "xargs rm",
      "ls | xargs rm",
      "sudo rm x",
      "sudo -u miro rm x",
      "doas rm x",
      "su -c 'rm x'",
      "nsenter -t 1 -m rm x",
      "chroot /mnt rm x",
      "docker exec c rm x",
      "docker exec -u root c rm -rf /config",
      "ssh localhost rm x",
      "bash -c 'rm x'",
      "sh -c \"rm -rf /x\"",
      "bash -c 'ls; rm x'",
      "ls; rm x",
      "ls && rm x",
      "ls || rm x",
      "ls | rm x",
      "ls\nrm x",
      "exec rm x",
      "sudo bash -c 'rm x'",
      "timeout 5 sudo nice rm x",
    ]);
  });
  test("block devices, formatting, power", () => {
    expectAll("forbidden", [
      "mkfs.ext4 /dev/sdb1",
      "mkfs -t ext4 /dev/sdb",
      "wipefs -a /dev/sda",
      "fdisk /dev/sda",
      "parted /dev/sda mklabel gpt",
      "dd if=/dev/zero of=/dev/sda",
      "dd if=x of=/dev/nvme0n1",
      "cat x > /dev/sda",
      "echo x > /dev/mapper/root",
      "reboot",
      "shutdown -h now",
      "halt",
      "poweroff",
      "init 0",
      "systemctl reboot",
      "systemctl poweroff",
      "sudo reboot",
    ]);
  });
  test("interactive shells and unbounded/interactive tools", () => {
    expectAll("forbidden", [
      "bash",
      "sh",
      "zsh",
      "sudo -i",
      "sudo -s",
      "sudo su",
      "sudo su -",
      "su",
      "su -",
      "docker exec -it c bash",
      "docker exec -it c sh",
      "nsenter -t 1 -m",
      "python3",
      "node",
      "watch ls",
      "yes",
      "top",
      "less /x",
      "vim /x",
      "ssh host",
    ]);
  });
  test("fork bomb shapes", () => {
    expectAll("forbidden", [":(){ :|:& };:", "bomb() { bomb | bomb & }; bomb"]);
  });
  test("catastrophic permission changes on the root filesystem", () => {
    expectAll("forbidden", ["chmod -R 000 /", "chown -R nobody /", "chmod -R 777 /usr"]);
  });
  test("reading secret material is never read-only", () => {
    expectAll("forbidden", [
      "cat /etc/shadow",
      "cat /home/miro/.ssh/id_ed25519",
      "cat ~/.ssh/id_rsa",
      "cat ~/.miro/secret.key",
      "cat /home/miro/.miro/miro.db",
      "cat /etc/wireguard/wg0.conf",
      "cat /opt/app/.env",
      "grep pass /etc/shadow",
    ]);
  });
  test("a symlink named ls that is really rm is caught by realpath", () => {
    const got = classifyCommand(`${untrustedDir}/shadow/ls x`, { resolveBinary: resolve, trustedBinDirs: [binDir, untrustedDir], home: "/home/miro" });
    expect(got.class).toBe("forbidden");
    expect(got.reasons[0]).toContain("really");
  });
});

describe("compound commands take the maximum class", () => {
  test("read + mutate = mutate; read + lifeline = lifeline", () => {
    expect(cls("ls && mkdir /tmp/x")).toBe("mutate");
    expect(cls("cat /etc/hosts; iptables -F")).toBe("lifeline");
    expect(cls("docker ps | grep x | xargs docker rm")).toBe("destructive");
  });
  test("segments report individual reasons", () => {
    const got = classifyCommand("ls; iptables -F", { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" });
    expect(got.segments.map((s) => s.class)).toEqual(["read", "lifeline"]);
    expect(got.reasons.join(" ")).toContain("iptables");
  });
});

describe("forbidden results carry an alternative", () => {
  test("rm points at file_delete", () => {
    const got = classifyCommand("rm -rf /srv/x", { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" });
    expect(got.alternative).toContain("file_delete");
  });
  test("reboot points at the reboot operation", () => {
    expect(classifyCommand("reboot", { resolveBinary: resolve, trustedBinDirs: [binDir], home: "/home/miro" }).alternative).toContain("reboot operation");
  });
});
