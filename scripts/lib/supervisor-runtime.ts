import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const absent = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1;

export async function runCommand(cmd: string, args: string[], opts: {
  cwd?: string; timeoutMs?: number; stdin?: string; env?: NodeJS.ProcessEnv; maxOutputBytes?: number;
  signal?: AbortSignal; onSpawn?: (pid: number) => void; onSettled?: (pid: number) => void;
  onStdout?: (data: Buffer) => void;
} = {}): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  if (process.platform === "win32") throw new Error("POSIX process groups required");
  if (opts.signal?.aborted) return { code: 130, stdout: "", stderr: "", timedOut: false };
  const limit = opts.maxOutputBytes ?? 128 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error("Invalid output buffer bound");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: "pipe" });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const tail = (old: Buffer, data: Buffer) => Buffer.concat([old, data]).subarray(-limit);
    child.stdout.on("data", (data: Buffer) => {
      stdout = tail(stdout, data);
      try { opts.onStdout?.(data); }
      catch (error) { failure = error; void finish(); }
    });
    child.stderr.on("data", (data: Buffer) => { stderr = tail(stderr, data); });
    // EPIPE is normal when a command exits without consuming its input.
    child.stdin.on("error", () => {});
    let timedOut = false, cancelled = false, finishing = false;
    let failure: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      try {
        const pid = child.pid;
        if (pid) {
          // Only signal the fresh detached group we created, never a checkpoint PID.
          // Once ESRCH is observed, never signal that numeric group again.
          let groupGone = false;
          const quiescent = () => (groupGone ||= absent(-pid));
          const signal = (sig: NodeJS.Signals) => {
            if (groupGone) return;
            try { process.kill(-pid, sig); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              groupGone = true;
            }
          };
          if (!quiescent()) {
            signal("SIGTERM");
            const deadline = Date.now() + 200;
            while (!quiescent() && Date.now() < deadline) await sleep(10);
            if (!quiescent()) signal("SIGKILL");
            const killDeadline = Date.now() + 5000;
            while (!quiescent()) {
              if (Date.now() >= killDeadline) throw new Error("Owned process group did not quiesce; retain lease for operator reconciliation");
              await sleep(10);
            }
          }
          // Wait for stdio to drain and the direct child to be reaped as well.
          await closed;
          opts.onSettled?.(pid);
        } else await closed;
        if (failure) throw failure;
        resolve({ code: timedOut ? 124 : cancelled ? 130 : exitCode ?? 1,
          stdout: stdout.toString(), stderr: stderr.toString(), timedOut });
      } catch (error) { reject(error); }
    };
    const closed = new Promise<void>((done) => child.once("close", done));
    const abort = () => { cancelled = true; void finish(); };
    child.once("error", (error) => { failure = error; void finish(); });
    child.once("exit", (code) => { exitCode = code; void finish(); });
    child.once("spawn", () => {
      try { opts.onSpawn?.(child.pid!); }
      catch (error) { failure = error; void finish(); return; }
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) abort();
      if (!finishing && opts.timeoutMs !== undefined) timer = setTimeout(() => {
        timedOut = true; void finish();
      }, opts.timeoutMs);
      child.stdin.end(opts.stdin);
    });
  });
}

export function readCheckpoint<T>(path: string): T | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

export function writeCheckpoint(path: string, value: unknown): void {
  const data = JSON.stringify(value);
  if (data === undefined) throw new Error("Checkpoint must be JSON serializable");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type Lease = { pid: number; nonce: string; children: number[] };
function readLease(path: string): Lease | undefined {
  const lease = readCheckpoint<Lease>(path);
  if (lease === undefined) return undefined;
  if (!lease || !validPid(lease.pid) || typeof lease.nonce !== "string" || !lease.nonce ||
      !Array.isArray(lease.children) || !lease.children.every(validPid)) {
    throw new Error("Invalid supervisor lease");
  }
  return lease;
}

export async function acquireSupervisorLease(path: string, options: { recoverChildren?: number[] } = {}): Promise<{
  registerChild(pid: number): void; unregisterChild(pid: number): void; release(): void;
}> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Every writer uses the same exclusive gate, including initial acquisition.
  // Never reclaim a gate: a crash *inside* this tiny critical section requires
  // operator inspection, rather than risking deletion of a fresh owner's lock.
  const gate = `${path}.guard`;
  function guarded<T>(fn: () => T): T {
    mkdirSync(gate, { mode: 0o700 });
    try { return fn(); } finally { rmdirSync(gate); }
  }
  const recoverChildren = [...new Set(options.recoverChildren ?? [])];
  if (!recoverChildren.every(validPid)) throw new Error("Invalid retained supervisor child identity");
  const owner: Lease = { pid: process.pid, nonce: randomUUID(), children: [] };
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      guarded(() => {
        const old = readLease(path);
        if (old && !absent(old.pid)) throw new Error("Supervisor lease still live (controller or child group)");
        if (old) {
          const liveChildren = old.children.filter((pid) => !absent(-pid));
          const retained = recoverChildren.filter((pid) => !absent(-pid));
          if (liveChildren.length && (liveChildren.length !== retained.length || liveChildren.some((pid) => !retained.includes(pid)))) {
            throw new Error("Supervisor lease has live unrecognized child groups; operator reconciliation required");
          }
          owner.children = liveChildren;
        }
        writeCheckpoint(path, owner);
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await sleep(10);
    }
  }
  let released = false;
  function update(fn: (lease: Lease) => boolean): void {
    if (released) throw new Error("Supervisor lease already released");
    guarded(() => {
      const current = readLease(path);
      if (!current || current.nonce !== owner.nonce) throw new Error("Supervisor lease ownership lost");
      if (fn(current)) writeCheckpoint(path, current);
      else { unlinkSync(path); released = true; }
    });
  }
  return {
    registerChild(pid) {
      if (!validPid(pid)) throw new Error("Invalid child process group");
      update((lease) => { if (!lease.children.includes(pid)) lease.children.push(pid); return true; });
    },
    unregisterChild(pid) {
      update((lease) => {
        if (!absent(-pid)) throw new Error("Child process group still live");
        lease.children = lease.children.filter((child) => child !== pid);
        return true;
      });
    },
    release() {
      update((lease) => {
        if (lease.children.some((pid) => !absent(-pid))) throw new Error("Child process group still live");
        return false;
      });
    },
  };
}
