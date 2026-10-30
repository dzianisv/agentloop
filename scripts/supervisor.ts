#!/usr/bin/env node
/** GitHub issue -> planner -> implementer -> controller checks -> independent review -> done. */
import { existsSync, readFileSync, readlinkSync, realpathSync, lstatSync, unlinkSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs as parseCli } from "node:util";
import { fileURLToPath } from "node:url";
import { runCommand, readCheckpoint, writeCheckpoint, acquireSupervisorLease } from "./lib/supervisor-runtime.js";
import { parseVerdict, verdictProblems, parseTimelinePrs, SHIPPING_POLICY, VERDICT_FORMAT } from "./lib/supervisor-policy.js";
import { closeSupervisorSdkServer, runSupervisorSdkAgent } from "./lib/supervisor-sdk.js";
import { resolveIssueWorktree } from "./lib/supervisor-worktree.js";
import { beginSupervisorAttempt, migrateSupervisorCheckpoint, nextSupervisorPhase, supervisorIteration, supervisorWaitingRetryAt, transitionSupervisorState } from "./lib/supervisor-state.js";
import type { PhaseCheckpoint, SupervisorCheckpoint, SupervisorPhase } from "./lib/supervisor-state.js";

const stop = new AbortController();
let lease: Awaited<ReturnType<typeof acquireSupervisorLease>> | undefined;
const redact = (s: string) => s.replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+|ntn_[\w]+)\b/g, "[REDACTED]");
async function run(cmd: string, args: string[], options: Parameters<typeof runCommand>[2] = {}) {
  return runCommand(cmd, args, { timeoutMs: 120_000, ...options, signal: stop.signal,
    onSpawn: (pid) => lease?.registerChild(pid), onSettled: (pid) => lease?.unregisterChild(pid) });
}
async function gh<T>(args: string[]): Promise<T> {
  const r = await run("gh", args, { maxOutputBytes: 4 * 1024 * 1024 });
  if (r.code) throw Error(redact(r.stderr || r.stdout));
  return JSON.parse(r.stdout) as T;
}
export async function linkedPrs(issue: number, repo: string) {
  const pages = await gh<unknown[][]>(["api", `repos/${repo}/issues/${issue}/timeline`, "--paginate", "--slurp"]);
  return parseTimelinePrs(pages);
}
export function isolateVerificationDependencies(path: string, root: string, allowOwnedDirectory = false): void {
  const modules = resolve(path, "node_modules");
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(modules); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (allowOwnedDirectory && stat.isDirectory()) return;
  if (!stat.isSymbolicLink() || realpathSync(modules) !== realpathSync(resolve(root, "node_modules"))) throw Error("Unexpected dependency tree; refusing to purge it");
  unlinkSync(modules);
}
export async function createWorktree(path: string, base: string, root: string, sharedDependencies = true): Promise<void> {
  if (existsSync(path)) throw Error(`Refusing to replace existing worktree ${path}`);
  const r = await run("git", ["worktree", "add", "--detach", path, base], { cwd: root });
  if (r.code) throw Error(r.stderr);
  if (!sharedDependencies) isolateVerificationDependencies(path, root, true);
}
export async function removeWorktree(path: string, root: string): Promise<void> {
  if (!existsSync(path)) return;
  const cleanupCommand = (args: string[], cwd: string) => runCommand("git", args, { cwd, timeoutMs: 15_000,
    onSpawn: pid => lease?.registerChild(pid), onSettled: pid => lease?.unregisterChild(pid) });
  // A previous cleanup can unregister the worktree but leave its directory behind. Treat an
  // unregistered directory as ours to delete instead of failing the phase that used it.
  const listed = await cleanupCommand(["worktree", "list", "--porcelain"], root);
  const registered = listed.code === 0 && listed.stdout.split("\n").includes(`worktree ${resolve(path)}`);
  if (!registered) { await rm(path, { recursive: true, force: true }); return; }
  const dirty = await cleanupCommand(["status", "--porcelain"], path);
  if (dirty.code || dirty.stdout.trim()) throw Error("Refusing to remove dirty or unreadable worktree");
  const r = await cleanupCommand(["worktree", "remove", path], root);
  if (r.code) throw Error(r.stderr.trim() || `git worktree remove failed for ${path} (exit ${r.code})`);
}

/** Run the supervisor harness typecheck only in targets that carry its project config. */
export function supervisorProjectTypecheckCommand(target: string): [string, string[]] | undefined {
  if (!existsSync(resolve(target, "tsconfig.supervisor.json"))) return undefined;
  return ["pnpm", ["exec", "tsc", "--noEmit", "--project", "tsconfig.supervisor.json"]];
}

/** The check phase already ran the full gate on this exact commit; a second identical run proves nothing new. */
export function canReuseMergedGate(testedSha: string | undefined, mergeSha: string, checks: PhaseCheckpoint["checks"] | undefined): boolean {
  return testedSha === mergeSha && Boolean(checks?.some(check => check.command === "pnpm run test:gate" && check.exitCode === 0 && check.testedSha === mergeSha));
}

async function verifyMergedCommit(sha: string, baseRef: string, root: string, ticketWorktree: string, timeoutMs: number,
  reuse?: { testedSha?: string; checks?: PhaseCheckpoint["checks"] }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("GitHub returned an invalid merge commit SHA");
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.startsWith("-")) throw Error("GitHub returned an invalid PR base ref");
  const present = await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root });
  if (present.code) {
    const fetched = await run("git", ["fetch", "--no-tags", "origin", baseRef], { cwd: root });
    if (fetched.code) throw Error(`Cannot fetch PR base ${baseRef} to verify merge commit ${sha}: ${redact(fetched.stderr || fetched.stdout)}`);
  }
  const commit = await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root });
  if (commit.code) throw Error(`Merge commit ${sha} is not available after fetching ${baseRef}`);
  const path = resolve(dirname(ticketWorktree), `.${basename(ticketWorktree)}-verify-${sha.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
  const added = await run("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, sha], { cwd: root });
  if (added.code) throw Error(`Cannot create isolated merge verification worktree: ${redact(added.stderr || added.stdout)}`);
  const checks: NonNullable<PhaseCheckpoint["mergeChecks"]> = [];
  try {
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: path });
    if (head.code || head.stdout.trim() !== sha) throw Error(`Verification worktree did not check out exact merge commit ${sha}`);
    const parent = await run("git", ["rev-parse", `${sha}^1`], { cwd: path });
    if (parent.code || !/^[a-f0-9]{40}$/.test(parent.stdout.trim())) throw Error(`Could not identify the first parent of merge commit ${sha}`);
    const baseSha = parent.stdout.trim();
    const changed = await run("git", ["diff", "--no-ext-diff", "--name-only", "-z", baseSha, sha], { cwd: path, maxOutputBytes: 64 * 1024 });
    const diff = await run("git", ["diff", "--no-ext-diff", "--unified=2", baseSha, sha], { cwd: path, maxOutputBytes: 64 * 1024 });
    if (changed.code || diff.code) throw Error(`Could not read the verified PR diff for merge commit ${sha}`);
    const changedFiles = changed.stdout.split("\0").filter(Boolean);
    const diffTruncated = diff.stdout.length >= 64 * 1024;
    const mergeDiff = `${diff.stdout}${diffTruncated ? "\n[merge commit diff truncated at 64 KiB]" : ""}`;
    if (canReuseMergedGate(reuse?.testedSha, sha, reuse?.checks)) {
      return { ok: true, testedSha: sha, checks: reuse!.checks!, changedFiles, diff: mergeDiff, diffTruncated, reused: true };
    }
    const install = await run("pnpm", ["install", "--frozen-lockfile"], { cwd: path, timeoutMs, maxOutputBytes: 32 * 1024 });
    if (install.code || install.timedOut) throw Error(`Isolated dependencies failed at merge ${sha}: ${redact(install.stderr || install.stdout).slice(-3000)}`);
    const commands: Array<[string, string[]]> = [["pnpm", ["run", "test:gate"]]];
    const projectTypecheck = supervisorProjectTypecheckCommand(path);
    if (projectTypecheck) commands.push(projectTypecheck);
    for (const [program, args] of commands) {
      const command = `${program} ${args.join(" ")}`;
      const result = await run(program, args, { cwd: path, timeoutMs, maxOutputBytes: 128 * 1024 });
      checks.push({ command, exitCode: result.timedOut ? 124 : result.code, testedSha: sha,
        output: redact(`${result.stdout}\n${result.stderr}`).slice(-3000) });
      if (result.code || result.timedOut) return { ok: false, testedSha: sha, checks, failedCommand: command, changedFiles, diff: mergeDiff, diffTruncated };
    }
    return { ok: true, testedSha: sha, checks, changedFiles, diff: mergeDiff, diffTruncated };
  } finally {
    await removeWorktree(path, root);
  }
}

export function buildPlannerPrompt(context: string, priorPlan = "", feedback = ""): string {
  const previous = priorPlan.trim() ? `\n\nPrior saved plan:\n${priorPlan}` : "";
  const replan = feedback.trim() ? `\n\nReviewer REPLAN feedback to resolve:\n${feedback}` : "";
  return `${context}${previous}${replan}\n\nInvestigate and return a short plan, affected files, acceptance criteria, and validation commands. No edits or external actions.`;
}

type Issue = { number: number; title: string; body: string; url: string; state: string; labels: { name: string }[] };
type State = SupervisorCheckpoint & { repo: string; issue: number; worktree?: string; sessionId?: string; implSessionId?: string;
  sessionDir?: string; sessionStarted?: boolean; adoptedPr?: number; mergeReconciledPr?: number; ownerId?: string;
  iterations?: number; activeIteration?: number; feedback?: string; lastImplSummary?: string; status?: string; openCodeSessionId?: string;
  [key: string]: unknown };
export type TicketOutcome =
  | { status: "waiting"; feedback?: string; retryAt: string }
  | { status: "pass" | "blocked" | "interrupted" | "unresolved"; feedback?: string; retryAt?: string };

/** Requeue waiting checkpoints without treating them as blocked or spinning immediately. */
export function scheduledRetryAt(status: string, retryAt: string | undefined, now = Date.now()): string | undefined {
  if (status !== "waiting") return undefined;
  return supervisorWaitingRetryAt(retryAt, now);
}

/** An adopted PR that merged while the controller was down must resume at verification, not the stale implement request. */
export function mergedAdoptionPhase(phase: string,
  checkpoint: { adoptedPr?: number; mergeReconciledPr?: number; worktreeClean: boolean },
  pr?: { number: number; state: string; mergeCommit: { oid: string } | null }): { mergeSha: string } | undefined {
  if (phase !== "plan" && phase !== "implement") return undefined;
  if (!checkpoint.worktreeClean || !checkpoint.adoptedPr || checkpoint.mergeReconciledPr === checkpoint.adoptedPr) return undefined;
  if (!pr || pr.number !== checkpoint.adoptedPr || pr.state !== "MERGED" || !pr.mergeCommit?.oid) return undefined;
  return { mergeSha: pr.mergeCommit.oid };
}

/** A clean tree has nothing for test:changed to select; the full gate is the proof there. */
export function controllerCheckCommands(changedFileCount: number, timeoutMs: number, checkTimeoutMs: number): Array<[string, string[], number]> {
  const commands: Array<[string, string[], number]> = [["git", ["diff", "--check", "HEAD"], timeoutMs]];
  if (changedFileCount > 0) commands.push(["pnpm", ["run", "test:changed"], timeoutMs]);
  commands.push(["pnpm", ["run", "test:gate"], checkTimeoutMs]);
  return commands;
}

/** The main queue uses this to retry the same issue after a durable waiting checkpoint. */
export function queuedTicket<T>(issue: T, outcome: TicketOutcome, now = Date.now()) {
  const retryAt = scheduledRetryAt(outcome.status, outcome.retryAt, now);
  return retryAt ? { pending: [issue], retryAt } : { pending: [] as T[], retryAt: undefined };
}

export function options(argv: string[]) {
  const string = (defaultValue?: string) => ({ type: "string" as const, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
  const bool = { type: "boolean" as const, default: false };
  const { values: v } = parseCli({ args: argv, options: {
    issue: string(), repo: string(), label: string("production-readiness"), limit: string("1"), drain: bool,
    runtime: string(), "probe-timeout-sec": string("120"),
    "max-iterations": string("3"), "timeout-sec": string("1800"), "check-timeout-sec": string("3600"), "state-dir": string(".supervisor"),
    worktree: string(), base: string("origin/main"), "adopt-pr": string(), "resume-session": string(),
    "dry-run": bool, "include-epics": bool, "verify-only": bool, "retry-exhausted": bool, "keep-open": bool,
    "self-test": bool, help: bool,
    // Accepted for old launch commands; no manual acceptance-plan framework is used.
    "acceptance-plan": string(), "max-retries": string("0"), "ticket-timeout-sec": string(),
  } });
  for (const key of ["limit", "max-iterations", "timeout-sec", "check-timeout-sec", "probe-timeout-sec"] as const) if (!Number.isSafeInteger(Number(v[key])) || Number(v[key]) < 1) throw Error(`${key} must be a positive integer`);
  for (const key of ["issue", "adopt-pr"] as const) if (v[key] && (!Number.isSafeInteger(Number(v[key])) || Number(v[key]) < 1)) throw Error(`Invalid ${key}`);
  if (v.runtime && v.runtime !== "opencode") throw Error("Only the OpenCode SDK runtime is supported; legacy Pi session IDs remain checkpoint history");
  const resume = v["resume-session"];
  if (resume && !/^ses_[A-Za-z0-9]+$/.test(resume)) throw Error("Only OpenCode ses_ session IDs can be resumed; legacy Pi IDs are retained as history");
  if (v.issue && v.drain) throw Error("Choose --issue or --drain");
  if ((v["adopt-pr"] || v["verify-only"]) && !v.issue) throw Error("Adoption/verification requires --issue");
  return { ...v };
}
type Options = ReturnType<typeof options>;

function phaseRecord(state: State, phase: SupervisorPhase): PhaseCheckpoint {
  return state.phases?.[phase] ?? { status: "pending" };
}

function mergedCooldowns(...maps: Array<Record<string, string> | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const map of maps) for (const [key, value] of Object.entries(map || {})) {
    if (!result[key] || Date.parse(value) > Date.parse(result[key]!)) result[key] = value;
  }
  return result;
}

async function waitForRetry(retryAt: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.parse(retryAt);
  while (!signal.aborted && Number.isFinite(deadline) && deadline > Date.now()) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.min(30_000, deadline - Date.now()));
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

function setPhaseRecord(state: State, phase: SupervisorPhase, patch: Partial<PhaseCheckpoint>, save: (patch?: Partial<State>) => void) {
  state.phases = { ...(state.phases ?? {}), [phase]: { ...phaseRecord(state, phase), ...patch, updatedAt: new Date().toISOString() } };
  if (state.phase === phase) state.phaseStatus = state.phases[phase]!.status;
  save({});
}

function movePhase(state: State, next: SupervisorPhase, phasePatch: Partial<PhaseCheckpoint>, save: (patch?: Partial<State>) => void,
  currentStatus: "complete" | "failed" = "complete") {
  const moved = transitionSupervisorState(state, next, { ...phasePatch, status: phasePatch.status ?? "pending" }, currentStatus);
  Object.assign(state, moved);
  save({});
}

async function worktreeFingerprint(worktree: string): Promise<{ sha: string; fingerprint: string; changedFiles: string[] }> {
  const diff = createHash("sha256");
  const [head, diffResult, status, untracked] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: worktree }),
    run("git", ["diff", "--binary", "HEAD"], { cwd: worktree, maxOutputBytes: 128, onStdout: data => diff.update(data) }),
    run("git", ["status", "--short", "--untracked-files=all"], { cwd: worktree }),
    run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree, maxOutputBytes: 4 * 1024 * 1024 }),
  ]);
  if (head.code || diffResult.code || status.code || untracked.code) throw new Error("Could not fingerprint the supervisor worktree");
  const digest = createHash("sha256").update(diff.digest());
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean).sort();
  for (const path of untrackedPaths) {
    const absolute = resolve(worktree, path);
    if (!absolute.startsWith(`${resolve(worktree)}/`)) throw new Error("Untracked path escapes the supervisor worktree");
    try {
      const stat = lstatSync(absolute);
      digest.update(path);
      if (stat.isSymbolicLink()) digest.update(`symlink:${readlinkSync(absolute)}`);
      else if (stat.isFile()) digest.update(readFileSync(absolute));
      else digest.update(`mode:${stat.mode};size:${stat.size}`);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error; }
  }
  return { sha: head.stdout.trim(), fingerprint: digest.digest("hex"), changedFiles: status.stdout.split(/\r?\n/).filter(Boolean) };
}

async function ticketWithSdk(issue: Issue, repo: string, root: string, worktree: string, relatedPrs: Array<{ number: number; state: string; title: string; mergedAt: string | null }>,
  opts: Options, state: State, save: (patch?: Partial<State>) => void): Promise<TicketOutcome> {
  const context = `Issue ${repo}#${issue.number}: ${issue.title}\n${issue.url}\n${issue.body}\nWorktree: ${worktree}`;
  const maxIterations = Number(opts["max-iterations"]);
  const timeoutMs = Number(opts["timeout-sec"]) * 1000;
  let iteration = supervisorIteration(state);
  if (state.phase === "done" && state.phaseStatus === "complete") return { status: "pass", feedback: String(state.feedback || "Workflow already completed") };

  const runRole = async (phase: SupervisorPhase, role: "planner" | "implementer" | "reviewer", prompt: string,
    excludeModel?: { providerId: string; modelId: string }) => {
    const current = phaseRecord(state, phase);
    if (current.requestStatus === "completed" && typeof current.result === "string") {
      if (current.status !== "pending") return { result: { ok: true as const, text: current.result, sessionId: current.sessionId || "" }, text: current.result };
    }
    const attempt = beginSupervisorAttempt(current);
    if (!attempt.sessionKey) attempt.sessionKey = randomUUID();
    setPhaseRecord(state, phase, attempt, save);
    const record = phaseRecord(state, phase);
    const call = await runSupervisorSdkAgent({
      role, prompt, phase: record, directory: worktree, sessionKey: record.sessionKey!, excludeModel,
      cooldowns: state.cooldowns, availability: state.availability, probe: state.probe,
      deadlineMs: Date.now() + timeoutMs, probeTimeoutMs: Number(opts["probe-timeout-sec"]) * 1000,
      signal: stop.signal,
      onSave(patch) {
        state.phases = { ...(state.phases || {}), [phase]: { ...phaseRecord(state, phase), ...patch, updatedAt: new Date().toISOString() } };
        if (state.phase === phase) state.phaseStatus = state.phases[phase]!.status;
        if (patch.cooldowns) state.cooldowns = mergedCooldowns(state.cooldowns, patch.cooldowns);
        save({});
      },
      onSaveGlobal(patch) {
        if (patch.probe === null) delete state.probe;
        else if (patch.probe) state.probe = patch.probe;
        if (patch.availability) state.availability = patch.availability;
        if (patch.cooldowns) state.cooldowns = mergedCooldowns(state.cooldowns, patch.cooldowns);
        save({});
      },
    });
    if (!call.ok) {
      const waiting = "waiting" in call;
      setPhaseRecord(state, phase, { status: waiting ? "waiting" : "blocked", error: call.error,
        ...(waiting ? { retryAt: call.retryAt } : {}), ...(call.sessionId ? { sessionId: call.sessionId } : {}) }, save);
      save({ status: waiting ? "waiting" : "blocked", feedback: call.error });
      return { result: call, text: "" };
    }
    setPhaseRecord(state, phase, { status: "complete", result: call.text, sessionId: call.sessionId, retryAt: undefined, error: undefined }, save);
    return { result: call, text: call.text };
  };

  while (true) {
    if (stop.signal.aborted) return { status: "interrupted", feedback: "Supervisor interrupted; checkpoint retained" };
    if (state.phase === "plan") {
      if (iteration > maxIterations) return { status: "unresolved", feedback: "Iteration limit reached with a replan checkpoint retained" };
      const planPhase = phaseRecord(state, "plan");
      if (planPhase.status !== "complete") {
        const result = await runRole("plan", "planner", buildPlannerPrompt(context, String(state.plan || ""),
          String(planPhase.error || state.feedback || "")));
        if (!result.result.ok) return "waiting" in result.result
          ? { status: "waiting", feedback: result.result.error, retryAt: result.result.retryAt }
          : { status: "blocked", feedback: result.result.error };
        if (stop.signal.aborted) return { status: "interrupted", feedback: "Supervisor interrupted after planning" };
        state.plan = result.text;
      } else state.plan = String(planPhase.result || state.plan || "");
      movePhase(state, "implement", { status: "pending" }, save);
      continue;
    }
    if (state.phase === "done") return { status: "pass", feedback: String(state.feedback || "Workflow already completed") };
    if (state.phase === "implement" && iteration > maxIterations) {
      const feedback = state.feedback || "Supervisor reached the implementation iteration limit";
      save({ status: "unresolved", feedback, activeIteration: undefined });
      return { status: "unresolved", feedback };
    }
    if (state.phase === "implement") save({ status: "running", activeIteration: Number(state.activeIteration || iteration) });
    else save({ status: "running" });

    if (state.phase === "implement") {
      const prior = String(phaseRecord(state, "implement").result || state.lastImplSummary || "No implementation summary yet.");
      const feedback = String(state.feedback || phaseRecord(state, "implement").error || "First attempt: follow the saved plan.");
      const result = await runRole("implement", "implementer", `${context}\n\nSaved plan (already checkpointed):\n${String(state.plan || "")}\n\nImplementation summary retained from the same session:\n${prior}\n\nReviewer/check feedback:\n${feedback}\n\nImplement the plan in this worktree. Follow the task authorization and current AGENTS.md delivery rules, including its sanctioned safe-merge and local-deploy path when authorized. When creating a PR, include these exact body lines: Supervisor-Issue: ${repo}#${issue.number} and Supervisor-Owner: ${state.ownerId}. Reuse an existing PR owned by this issue; do not create a duplicate. Do not bypass gates, create release tags, purchase infrastructure, or mutate customer systems without explicit authorization. Do not close the issue; the controller owns issue closure and evidence reconciliation. Avoid repeating already completed external actions.`);
      if (!result.result.ok) return "waiting" in result.result
        ? { status: "waiting", feedback: result.result.error, retryAt: result.result.retryAt }
        : { status: "blocked", feedback: result.result.error };
      state.lastImplSummary = result.text;
      state.feedback = "";
      save({ iterations: iteration, activeIteration: undefined });
      setPhaseRecord(state, "implement", { status: "complete", result: result.text }, save);
      movePhase(state, "check", { status: "pending", checks: undefined, testedSha: undefined, testedTree: undefined,
        mergeChecks: undefined, mergeTestedSha: undefined }, save);
    }

    if (state.phase === "check") {
      const before = await worktreeFingerprint(worktree);
      setPhaseRecord(state, "check", { status: "running", checks: [], testedSha: undefined, testedTree: undefined, error: undefined }, save);
      const checkTimeoutMs = Number(opts["check-timeout-sec"]) * 1000;
      const commands = controllerCheckCommands(before.changedFiles.length, timeoutMs, checkTimeoutMs);
      const projectTypecheck = supervisorProjectTypecheckCommand(worktree);
      if (projectTypecheck) commands.push([projectTypecheck[0], projectTypecheck[1], timeoutMs]);
      const checks: NonNullable<PhaseCheckpoint["checks"]> = [];
      let failed = false;
      for (const [program, args, commandTimeoutMs] of commands) {
        const command = `${program} ${args.join(" ")}`;
        const output = await run(program, args, { cwd: worktree, timeoutMs: commandTimeoutMs, maxOutputBytes: 128 * 1024 });
        checks.push({ command, exitCode: output.code, testedSha: before.sha, output: redact(`${output.stdout}\n${output.stderr}`).slice(-3000) });
        setPhaseRecord(state, "check", { checks: [...checks] }, save);
        if (output.code !== 0 || output.timedOut) { failed = true; break; }
      }
      const after = await worktreeFingerprint(worktree);
      if (before.fingerprint !== after.fingerprint) { failed = true; checks.push({ command: "worktree fingerprint stable", exitCode: 1, testedSha: before.sha, output: "Worktree changed during checks; proof is stale" }); }
      setPhaseRecord(state, "check", { checks, testedSha: before.sha, testedTree: before.fingerprint,
        status: failed ? "failed" : "complete", error: failed ? checks.find(check => check.exitCode !== 0)?.output || "Worktree changed during checks" : undefined }, save);
      if (failed) {
        state.feedback = `Controller checks failed on ${before.sha}. Fix the reported failure and rerun the check phase.\n${checks.map(check => `${check.command} exited ${check.exitCode}:\n${check.output || "(no output)"}`).join("\n")}`;
        iteration++;
        save({ activeIteration: iteration });
        movePhase(state, nextSupervisorPhase("check", "check-failed"), { status: "pending", error: state.feedback }, save, "failed");
        continue;
      }
      movePhase(state, "review", { status: "pending" }, save);
    }

    if (state.phase === "review") {
      const proof = phaseRecord(state, "check");
      const current = await worktreeFingerprint(worktree);
      if (!proof.testedSha || !proof.testedTree || proof.testedTree !== current.fingerprint) {
        state.feedback = "Controller check evidence is stale because the worktree changed. Rerun checks before review.";
        movePhase(state, "check", { status: "pending", error: state.feedback }, save, "failed");
        continue;
      }
      const dirtyDiffResult = await run("git", ["diff", "--no-ext-diff", "--unified=2", "HEAD"], { cwd: worktree, maxOutputBytes: 64 * 1024 });
      if (dirtyDiffResult.code) throw Error("Could not read the checked worktree diff for review");
      const dirtyDiff = `${dirtyDiffResult.stdout}${dirtyDiffResult.stdout.length >= 64 * 1024 ? "\n[worktree diff truncated at 64 KiB]" : ""}`;
      const priorModel = phaseRecord(state, "implement");
      const excluded = priorModel.provider && priorModel.model ? { providerId: priorModel.provider, modelId: priorModel.model } : undefined;
      const issueEvidence = await gh<{ number: number; state: string; url: string }>(["issue", "view", String(issue.number), "--repo", repo, "--json", "number,state,url"]);
      const refreshedRelatedPrs = await linkedPrs(issue.number, repo);
      const reviewRelatedPrs = [...new Map([...relatedPrs, ...refreshedRelatedPrs].map(pr => [pr.number, pr])).values()];
      const prEvidence = await Promise.all(reviewRelatedPrs.map(async pr => {
        const observed = await gh<{ number: number; state: string; url: string; body: string; headRefOid: string; baseRefName: string;
          mergeCommit: { oid: string } | null; closingIssuesReferences?: Array<{ number: number }>;
          statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string }> }>(["pr", "view", String(pr.number), "--repo", repo,
          "--json", "number,state,url,body,headRefOid,baseRefName,mergeCommit,closingIssuesReferences,statusCheckRollup"]);
        const ownsIssue = observed.closingIssuesReferences?.some(reference => reference.number === issue.number) ||
          observed.body.split(/\r?\n/).includes(`Supervisor-Issue: ${repo}#${issue.number}`);
        return { number: observed.number, state: observed.state, url: observed.url, headRefOid: observed.headRefOid,
          baseRefName: observed.baseRefName, ownsIssue: !!ownsIssue, mergeSha: observed.mergeCommit?.oid || null,
          checks: (observed.statusCheckRollup || []).slice(0, 50) };
      }));
      const deliveryPr = (state.adoptedPr ? prEvidence.find(pr => pr.number === state.adoptedPr) : undefined) ||
        prEvidence.filter(pr => pr.ownsIssue).at(-1);
      if (!deliveryPr || deliveryPr.state !== "MERGED" || !deliveryPr.mergeSha) {
        const feedback = !deliveryPr
          ? "No linked pull request currently owns this issue; create and push the required PR using repository helpers."
          : `Pull request #${deliveryPr.number} is ${deliveryPr.state}; finish delivery with the repository's sanctioned safe-merge path when authorized, then resume review.`;
        state.feedback = feedback;
        iteration++;
        save({ activeIteration: iteration });
        movePhase(state, "implement", { status: "pending", error: feedback }, save);
        continue;
      }
      const mergeProof = await verifyMergedCommit(deliveryPr.mergeSha, deliveryPr.baseRefName, root, worktree, Number(opts["check-timeout-sec"]) * 1000,
        phaseRecord(state, "check"));
      setPhaseRecord(state, "check", { mergeTestedSha: mergeProof.testedSha, mergeChecks: mergeProof.checks }, save);
      if (!mergeProof.ok) {
        const feedback = `Exact merge commit ${mergeProof.testedSha} failed ${mergeProof.failedCommand}. Diagnose the failure and deliver a tested follow-up through the normal PR path.\n${mergeProof.checks.map(check => `${check.command} exited ${check.exitCode}:\n${check.output || "(no output)"}`).join("\n")}`;
        state.feedback = feedback;
        iteration++;
        save({ activeIteration: iteration });
        movePhase(state, "implement", { status: "pending", error: feedback }, save);
        continue;
      }
      const prPatchResult = await run("gh", ["pr", "diff", String(deliveryPr.number), "--repo", repo, "--patch", "--color", "never"],
        { maxOutputBytes: 64 * 1024 });
      const prFilesResult = await run("gh", ["pr", "diff", String(deliveryPr.number), "--repo", repo, "--name-only"],
        { maxOutputBytes: 64 * 1024 });
      if (prPatchResult.code || prFilesResult.code) throw Error("Could not read the linked PR diff for the reviewer");
      const prDiffTruncated = prPatchResult.stdout.length >= 64 * 1024;
      const prDiff = `${prPatchResult.stdout}${prDiffTruncated ? "\n[GitHub PR diff truncated at 64 KiB]" : ""}`;
      const prChangedFiles = prFilesResult.stdout.split(/\r?\n/).filter(Boolean);
      const controllerEvidence = { observedAt: new Date().toISOString(), issue: issueEvidence, pullRequests: prEvidence,
        localChecks: proof.checks, testedHead: proof.testedSha, worktreeFingerprint: proof.testedTree,
        mergeCommitChecks: mergeProof.checks, mergeTestedSha: mergeProof.testedSha,
        mergeChangedFiles: mergeProof.changedFiles, mergeDiffTruncated: mergeProof.diffTruncated,
        prChangedFiles, prDiffTruncated };
      const changed = `Verified merge-commit paths:\n${mergeProof.changedFiles.join("\n") || "(none)"}\n\nGitHub PR paths:\n${prChangedFiles.join("\n") || "(none)"}\n\nCurrent worktree paths/status:\n${current.changedFiles.join("\n") || "(clean)"}`;
      const reviewDiff = `Verified merge-commit first-parent diff (bounded to 64 KiB):\n${redact(mergeProof.diff)}\n\nGitHub PR diff (bounded to 64 KiB):\n${redact(prDiff)}\n\nChecked worktree diff (bounded to 64 KiB):\n${redact(dirtyDiff)}`;
      const reviewer = await runRole("review", "reviewer", `${context}\n\nCurrent related PRs observed at review time:\n${JSON.stringify(reviewRelatedPrs)}\n\nSaved plan:\n${String(state.plan || "")}\n\nChanged files:\n${changed}\n\n${reviewDiff}\n\nController-observed delivery and test evidence:\n${JSON.stringify(controllerEvidence)}\n\nImplementation summary:\n${String(priorModel.result || state.lastImplSummary || "")}\n\nInspect the supplied verified PR diff and corresponding worktree files with read-only tools. Return RESULT: PASS, RESULT: IMPLEMENTATION_FEEDBACK, or RESULT: REPLAN. Use the supplied controller facts for issue/PR/check state; do not claim unobserved external delivery. LOCAL_TEST_SHA must equal mergeTestedSha in the supplied controller evidence. If the diff is truncated, inspect the listed files needed to reach a verdict. If you return PASS, include the exact delivery block below. A PASS cannot skip controller verification or mark delivery complete on its own.\n\n${VERDICT_FORMAT}`,
        excluded);
      if (!reviewer.result.ok) return "waiting" in reviewer.result
        ? { status: "waiting", feedback: reviewer.result.error, retryAt: reviewer.result.retryAt }
        : { status: "blocked", feedback: reviewer.result.error };
      const resultType = reviewer.text.match(/^\s*RESULT:\s*(PASS|IMPLEMENTATION_FEEDBACK|REPLAN)\s*$/im)?.[1];
      if (resultType === "IMPLEMENTATION_FEEDBACK" || !resultType) {
        state.feedback = reviewer.text;
        iteration++;
        save({ activeIteration: iteration });
        movePhase(state, "implement", { status: "pending", error: reviewer.text }, save);
        continue;
      }
      if (resultType === "REPLAN") {
        state.feedback = reviewer.text;
        iteration++;
        save({ activeIteration: iteration });
        movePhase(state, "plan", { status: "pending", error: reviewer.text }, save);
        continue;
      }
      const verdict = parseVerdict(reviewer.text);
      const prNumber = /^#(\d+)$/.exec(verdict.pr || "");
      const problems = prNumber
        ? verdictProblems(verdict, issue.number, await gh(["pr", "view", prNumber[1], "--repo", repo, "--json", "number,state,headRefOid,mergeCommit"]))
        : verdict.issue === `#${issue.number}` && verdict.pr === "none" && verdict.deployed === "n/a" && verdict.delivered === "yes" && verdict.blockers === "none" && (verdict.evidence?.length || 0) >= 20
          ? [] : ["Reviewer PASS lacks controller-verifiable issue/PR delivery evidence"];
      if (prNumber && Number(prNumber[1]) !== deliveryPr.number) problems.push("Reviewer selected a PR without the controller's issue-ownership marker");
      if (verdict.localTestSha !== mergeProof.testedSha || mergeProof.testedSha !== deliveryPr.mergeSha) problems.push("Controller did not test the exact selected PR merge commit");
      if (proof.testedSha !== current.sha) problems.push("Controller branch-head checks do not match the current worktree HEAD");
      if (problems.length) {
        const feedback = `Reviewer returned PASS, but delivery remains unverified: ${problems.join("; ")}. The controller will not mark done until safe-merge/live-delivery evidence is independently present.`;
        const retryAt = supervisorWaitingRetryAt();
        setPhaseRecord(state, "review", { status: "waiting", retryAt, error: feedback }, save);
        save({ status: "waiting", feedback });
        return { status: "waiting", feedback, retryAt };
      }
      if (!opts["keep-open"]) {
        const closed = await gh<Issue>(["issue", "view", String(issue.number), "--repo", repo, "--json", "state"]);
        if (closed.state !== "CLOSED") {
          const close = await run("gh", ["issue", "close", String(issue.number), "--repo", repo, "--comment", `Supervisor SDK workflow accepted after exact-SHA checks and live delivery verification.\n\n${reviewer.text}`]);
          if (close.code) throw new Error(redact(close.stderr || close.stdout));
          if ((await gh<Issue>(["issue", "view", String(issue.number), "--repo", repo, "--json", "state"])).state !== "CLOSED") throw new Error("Issue closure not confirmed");
        }
      }
      movePhase(state, "done", { status: "complete", result: reviewer.text }, save);
      save({ status: "pass", feedback: verdict.evidence });
      return { status: "pass", feedback: verdict.evidence };
    }
  }
}

async function ticket(issue: Issue, repo: string, root: string, opts: Options, dir: string,
  sharedCooldowns: Record<string, string>, cooldownFile: string): Promise<TicketOutcome> {
  const file = resolve(dir, `state-${repo.replace("/", "-")}-${issue.number}.json`);
  const rawSaved = readCheckpoint<State>(file);
  const saved = rawSaved ? migrateSupervisorCheckpoint(rawSaved) as State : undefined;
  if (saved && (saved.repo !== repo || saved.issue !== issue.number)) throw Error("Checkpoint belongs to another issue/repository");
  const related = await linkedPrs(issue.number, repo);
  const adoptedPr = Number(opts["adopt-pr"] || saved?.adoptedPr) || undefined;
  const ownership = (p: { body: string; closingIssuesReferences: { number: number }[] }) => p.closingIssuesReferences.some((i) => i.number === issue.number) || p.body.split(/\r?\n/).includes(`Supervisor-Issue: ${repo}#${issue.number}`);
  for (const relatedPr of related.filter((p) => p.state === "OPEN" || p.number === adoptedPr)) {
    const pr = await gh<{ number: number; body: string; closingIssuesReferences: { number: number }[] }>(["pr", "view", String(relatedPr.number), "--repo", repo, "--json", "number,body,closingIssuesReferences"]);
    if (pr.number === adoptedPr && !ownership(pr)) throw Error("Adopted PR does not own this issue");
    if (relatedPr.state === "OPEN" && ownership(pr) && pr.number !== adoptedPr && !(saved?.ownerId && pr.body.split(/\r?\n/).includes(`Supervisor-Owner: ${saved.ownerId}`))) return { status: "blocked", feedback: `PR #${pr.number} owns this issue and needs explicit adoption; no duplicate created` };
  }
  if (adoptedPr && !related.some((p) => p.number === adoptedPr)) throw Error("Adopted PR is not linked to this issue");
  const worktreeChoice = resolveIssueWorktree({ root, issue: issue.number,
    savedWorktree: saved?.worktree, explicitWorktree: opts.worktree });
  const worktree = worktreeChoice.worktree;
  if (existsSync(worktree) && !worktreeChoice.managed) throw Error("Existing worktree needs explicit --worktree; it will not be overwritten");
  const state: State = { ...saved, repo, issue: issue.number, worktree, adoptedPr,
    ownerId: saved?.ownerId || randomUUID(),
    iterations: opts["retry-exhausted"] ? 0 : saved?.iterations || 0,
    activeIteration: opts["retry-exhausted"] ? undefined : saved?.activeIteration, status: "running" };
  state.cooldowns = mergedCooldowns(sharedCooldowns, saved?.cooldowns);
  state.phase ??= "plan";
  state.phaseStatus ??= "pending";
  state.phases ??= { plan: { status: "pending" } };
  if (opts["resume-session"]) {
    state.phases.implement = { ...(state.phases.implement ?? { status: "running" }), sessionId: opts["resume-session"] };
    state.phase = "implement";
  }
  if (saved?.openCodeSessionId && !state.phases.implement?.sessionId) {
    state.phases.implement = { ...(state.phases.implement ?? { status: "running" }), sessionId: saved.openCodeSessionId };
  }
  writeCheckpoint(file, state);
  if (!existsSync(worktree)) {
    const fetch = await run("git", ["fetch", "origin", opts.base!.replace(/^origin\//, "")], { cwd: root });
    if (fetch.code) throw Error(fetch.stderr);
    if (adoptedPr) {
      const fetched = await run("git", ["fetch", "origin", `pull/${adoptedPr}/head`], { cwd: root });
      if (fetched.code) throw Error(fetched.stderr);
    }
    await createWorktree(worktree, adoptedPr ? "FETCH_HEAD" : opts.base!, root);
  }
  const actual = await run("git", ["rev-parse", "--git-common-dir"], { cwd: worktree });
  const expected = await run("git", ["rev-parse", "--git-common-dir"], { cwd: root });
  if (actual.code || expected.code || realpathSync(resolve(worktree, actual.stdout.trim())) !== realpathSync(resolve(root, expected.stdout.trim()))) throw Error("Worktree belongs to another repository");
  const save = (patch: Partial<State> = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    Object.assign(sharedCooldowns, mergedCooldowns(sharedCooldowns, state.cooldowns));
    state.cooldowns = { ...sharedCooldowns };
    writeCheckpoint(file, state);
    writeCheckpoint(cooldownFile, sharedCooldowns);
  };
  if (state.adoptedPr && (state.phase === "plan" || state.phase === "implement")) {
    const adopted = await gh<{ number: number; state: string; mergeCommit: { oid: string } | null }>(["pr", "view",
      String(state.adoptedPr), "--repo", repo, "--json", "number,state,mergeCommit"]);
    const observed = await worktreeFingerprint(worktree);
    const merged = mergedAdoptionPhase(state.phase, { adoptedPr: state.adoptedPr, mergeReconciledPr: state.mergeReconciledPr,
      worktreeClean: observed.changedFiles.length === 0 }, adopted);
    if (merged) {
      const checkout = await run("git", ["checkout", "--detach", merged.mergeSha], { cwd: worktree });
      if (checkout.code) throw Error(`Could not resume merged adoption: ${checkout.stderr}`);
      state.mergeReconciledPr = adopted.number;
      state.feedback = `Adopted pull request #${adopted.number} merged at ${merged.mergeSha}; resuming at controller verification instead of the stale implementation request.`;
      movePhase(state, "check", { status: "pending", checks: undefined, testedSha: undefined, testedTree: undefined,
        mergeChecks: undefined, mergeTestedSha: undefined }, save);
      save({ status: "running" });
    }
  }
  const context = `Issue ${repo}#${issue.number}: ${issue.title}\n${issue.url}\n${issue.body}\nRelated PRs: ${JSON.stringify(related)}\nWorktree: ${worktree}`;
  if (opts["verify-only"] && state.phase === "implement" && (state.lastImplSummary || state.phases.implement?.result)) {
    setPhaseRecord(state, "implement", { status: "complete" }, save);
    movePhase(state, "check", { status: "pending" }, save);
  }
  const outcome = await ticketWithSdk(issue, repo, root, worktree, related, opts, state, save);
  if (outcome.status !== "waiting") return outcome;
  const retryAt = supervisorWaitingRetryAt(outcome.retryAt);
  const phase = state.phase || "plan";
  state.phases = { ...(state.phases || {}), [phase]: { ...phaseRecord(state, phase), status: "waiting",
    retryAt, ...(outcome.feedback ? { error: outcome.feedback } : {}) } };
  state.phaseStatus = "waiting";
  save({ status: "waiting", feedback: outcome.feedback });
  return { ...outcome, retryAt };
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) { console.log("supervisor.ts --issue N [--adopt-pr N --worktree PATH] | --drain --label production-readiness\nDefault: OpenCode SDK planner -> implementer -> controller checks -> reviewer -> done. Uses a healthy OpenCode server at 127.0.0.1:4096 or starts one with the official SDK helper. Models are selected from the ordered subscription groups; availability is checked with a disposable no-tools session before task dispatch.\nGroups: OpenCode subscription pair first, then configured OpenRouter provider identities, then connected ChatGPT OAuth. The OpenRouter key2 group is used only when a separate openrouter-2 provider alias is already configured. No paid API fallback.\nOptions: --runtime opencode --probe-timeout-sec 120 (default) --max-iterations 3 --timeout-sec 1800 --check-timeout-sec 3600. Legacy Pi IDs stay in checkpoints as history and cannot be resumed."); return; }
  if (opts["self-test"]) {
    if (parseVerdict("VERDICT: PASS\nVERDICT: FAIL").verdict || !verdictProblems(parseVerdict("VERDICT: PASS"), 1).length) throw Error("Unsafe verdict parser");
    console.log("SELF-TEST OK: false/ambiguous completion rejected; not delivery proof"); return;
  }
  const rootResult = await run("git", ["rev-parse", "--show-toplevel"]);
  if (rootResult.code) throw Error("Run inside the assigned repository");
  const root = realpathSync(rootResult.stdout.trim());
  const repo = (await gh<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  if (opts.repo && opts.repo !== repo) throw Error("Repository identity mismatch");
  let issues = opts.issue ? [await gh<Issue>(["issue", "view", opts.issue, "--repo", repo, "--json", "number,title,body,url,state,labels"])]
    : (await gh<Issue[][]>(["api", `repos/${repo}/issues?state=open&labels=${encodeURIComponent(opts.label!)}&per_page=100`, "--paginate", "--slurp"])).flat().filter((i: Issue & { pull_request?: unknown }) => !i.pull_request && (opts["include-epics"] || !/^\[EPIC\b/i.test(i.title) && !i.labels.some((l) => l.name === "epic"))).sort((a, b) => a.number - b.number);
  if (!opts.drain) issues = issues.slice(0, Number(opts.limit));
  if (opts["dry-run"]) {
    const selected = []; for (const issue of issues) selected.push({ issue: issue.number, title: issue.title, state: issue.state, relatedPrs: await linkedPrs(issue.number, repo) });
    console.log(JSON.stringify({ repo, selected, note: "No agents/model calls, worktree creation or delivery performed" }, null, 2)); return;
  }
  const dir = resolve(root, opts["state-dir"]!); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cooldownFile = resolve(dir, `cooldowns-${repo.replace("/", "-")}.json`);
  const savedCooldowns = readCheckpoint<Record<string, string>>(cooldownFile) || {};
  if (Object.entries(savedCooldowns).some(([key, date]) => !/^[a-f0-9]{16}$/.test(key) || typeof date !== "string" || !Number.isFinite(Date.parse(date)))) {
    throw new Error("Invalid supervisor account/model cooldown checkpoint");
  }
  const sharedCooldowns = savedCooldowns;
  lease = await acquireSupervisorLease(resolve(homedir(), ".local/state/agentpod-supervisor", `${repo.replace("/", "-")}.lock`));
  const cancel = () => stop.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const finalResults = new Map<number, { issue: number; status: string; feedback?: string }>();
  try {
    let pending = issues;
    while (pending.length && !stop.signal.aborted) {
      const retry: Array<{ issue: Issue; retryAt: string }> = [];
      for (const issue of pending) {
        if (stop.signal.aborted) break;
        try {
          const outcome = await ticket(issue, repo, root, opts, dir, sharedCooldowns, cooldownFile);
          finalResults.set(issue.number, { issue: issue.number, ...outcome });
          const queued = queuedTicket(issue, outcome);
          const retryAt = queued.retryAt || (outcome.status === "waiting" ? supervisorWaitingRetryAt(outcome.retryAt) : undefined);
          if (retryAt) retry.push({ issue, retryAt });
        } catch (e) {
          const feedback = redact(String(e)); console.error(`#${issue.number}: ${feedback}`);
          finalResults.set(issue.number, { issue: issue.number, status: "blocked", feedback });
        }
      }
      if (!retry.length || stop.signal.aborted) break;
      const nextRetry = retry.map(item => item.retryAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
      console.log(`Supervisor waiting until ${nextRetry} before resuming ${retry.length} waiting checkpoint(s)`);
      await waitForRetry(nextRetry, stop.signal);
      pending = retry.map(item => item.issue);
    }
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    await closeSupervisorSdkServer();
    lease.release();
    lease = undefined;
  }
  const results = [...finalResults.values()];
  console.log(JSON.stringify({ selected: issues.length, passed: results.filter((r) => r.status === "pass").length, results, notAttempted: issues.filter((i) => !finalResults.has(i.number)).map((i) => i.number), productionReadiness: "NOT ASSERTED" }, null, 2));
  process.exitCode = stop.signal.aborted ? 130 : issues.length > 0 && results.length === issues.length && results.every((r) => r.status === "pass") ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(redact(String(e))); process.exitCode = 2; });
