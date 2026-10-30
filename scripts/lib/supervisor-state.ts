/** Small, versioned-by-shape checkpoint for the supervisor's restartable phases. */
export const SUPERVISOR_PHASES = ["plan", "implement", "check", "review", "done"] as const;
export type SupervisorPhase = typeof SUPERVISOR_PHASES[number];
export type PhaseStatus = "pending" | "running" | "complete" | "waiting" | "blocked" | "failed";
export type ProbeCheckpoint = {
  candidateKey: string;
  groupId: string;
  provider: string;
  model: string;
  reasoning: string;
  credentialId: string;
  sessionKey: string;
  requestId: string;
  sessionId?: string;
  requestStatus: "prepared" | "admitted";
  transport?: "public";
  startedAt: string;
};
export type AvailabilityCacheEntry = { status: "available" | "unavailable"; expiresAt: string; reason?: string };

export type PhaseCheckpoint = {
  status: PhaseStatus;
  sessionId?: string;
  sessionKey?: string;
  requestId?: string;
  requestStatus?: "prepared" | "admitted" | "completed" | "interrupted";
  requestMessageId?: string;
  recoveries?: number;
  requestFingerprint?: string;
  transport?: "public";
  model?: string;
  provider?: string;
  credentialId?: string;
  reasoning?: string;
  candidateIndex?: number;
  attempts?: number;
  cooldowns?: Record<string, string>;
  rotation?: { nextCandidateIndex: number; candidateKey?: string };
  result?: string;
  error?: string;
  retryAt?: string;
  testedSha?: string;
  testedTree?: string;
  checks?: Array<{ command: string; exitCode: number; testedSha: string; output?: string }>;
  mergeTestedSha?: string;
  mergeChecks?: Array<{ command: string; exitCode: number; testedSha: string; output?: string }>;
  permission?: { id: string; action: string; sessionId: string };
  updatedAt?: string;
};

export type SupervisorCheckpoint = {
  phase?: SupervisorPhase;
  phaseStatus?: PhaseStatus;
  phases?: Partial<Record<SupervisorPhase, PhaseCheckpoint>>;
  plan?: string;
  testedSha?: string;
  testedTree?: string;
  cooldowns?: Record<string, string>;
  availability?: Record<string, AvailabilityCacheEntry>;
  probe?: ProbeCheckpoint;
  activeIteration?: number;
  [key: string]: unknown;
};

/** A waiting checkpoint always has a future wake time, even when its caller lost the original retry hint. */
export function supervisorWaitingRetryAt(retryAt?: string, now = Date.now()): string {
  const suggested = Date.parse(retryAt || "");
  return new Date(Number.isFinite(suggested) ? Math.max(suggested, now + 5_000) : now + 60_000).toISOString();
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const statuses: PhaseStatus[] = ["pending", "running", "complete", "waiting", "blocked", "failed"];
const validTimestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const validShortText = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);

function isPhase(value: unknown): value is SupervisorPhase {
  return typeof value === "string" && (SUPERVISOR_PHASES as readonly string[]).includes(value);
}

function validPhaseRecord(value: unknown, phase: SupervisorPhase): PhaseCheckpoint {
  if (!object(value)) return { status: "pending" };
  if (!statuses.includes(value.status as PhaseStatus)) throw new Error(`Invalid supervisor ${phase} checkpoint status`);
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(value.sessionId))) {
    throw new Error(`Invalid supervisor ${phase} OpenCode session ID`);
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !/^msg_[A-Za-z0-9]+$/.test(value.requestId))) {
    throw new Error(`Invalid supervisor ${phase} OpenCode request ID`);
  }
  if (value.requestMessageId !== undefined && (typeof value.requestMessageId !== "string" || !/^msg_[A-Za-z0-9]+$/.test(value.requestMessageId))) throw new Error(`Invalid supervisor ${phase} message ID`);
  if (value.requestStatus !== undefined && !["prepared", "admitted", "completed", "interrupted"].includes(String(value.requestStatus))) throw new Error(`Invalid supervisor ${phase} request status`);
  if (value.sessionKey !== undefined && !validShortText(value.sessionKey)) throw new Error(`Invalid supervisor ${phase} session key`);
  for (const field of ["model", "provider", "credentialId", "reasoning", "error", "retryAt"] as const) {
    if (value[field] !== undefined && (field === "retryAt" ? !validTimestamp(value[field]) : typeof value[field] !== "string" || (value[field] as string).length > 8192)) {
      throw new Error(`Invalid supervisor ${phase} ${field}`);
    }
  }
  if (value.transport !== undefined && value.transport !== "public") throw new Error(`Invalid supervisor ${phase} transport`);
  if (value.result !== undefined && (typeof value.result !== "string" || Buffer.byteLength(value.result) > 8 * 1024 * 1024)) throw new Error(`Invalid supervisor ${phase} result`);
  if (value.requestFingerprint !== undefined && (typeof value.requestFingerprint !== "string" || !/^[a-f0-9]{16}$/.test(value.requestFingerprint))) throw new Error(`Invalid supervisor ${phase} request fingerprint`);
  if (value.candidateIndex !== undefined && (!Number.isSafeInteger(value.candidateIndex) || (value.candidateIndex as number) < 0 || (value.candidateIndex as number) > 16)) throw new Error(`Invalid supervisor ${phase} candidate index`);
  if (value.rotation !== undefined && (!object(value.rotation) || !Number.isSafeInteger(value.rotation.nextCandidateIndex) || (value.rotation.nextCandidateIndex as number) < 0 || (value.rotation.nextCandidateIndex as number) > 16 ||
      value.rotation.candidateKey !== undefined && (typeof value.rotation.candidateKey !== "string" || !/^[a-f0-9]{16}$/.test(value.rotation.candidateKey)))) throw new Error(`Invalid supervisor ${phase} rotation checkpoint`);
  if (value.attempts !== undefined && (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || (value.attempts as number) > 1000)) throw new Error(`Invalid supervisor ${phase} attempt count`);
  if (value.recoveries !== undefined && (!Number.isSafeInteger(value.recoveries) || (value.recoveries as number) < 0 || (value.recoveries as number) > 1)) throw new Error(`Invalid supervisor ${phase} recovery count`);
  if (value.testedSha !== undefined && (typeof value.testedSha !== "string" || !/^[a-f0-9]{40}$/.test(value.testedSha))) throw new Error(`Invalid supervisor ${phase} tested SHA`);
  if (value.mergeTestedSha !== undefined && (typeof value.mergeTestedSha !== "string" || !/^[a-f0-9]{40}$/.test(value.mergeTestedSha))) throw new Error(`Invalid supervisor ${phase} merge-tested SHA`);
  if (value.testedTree !== undefined && (typeof value.testedTree !== "string" || !/^[a-f0-9]{64}$/.test(value.testedTree))) throw new Error(`Invalid supervisor ${phase} worktree fingerprint`);
  if (value.cooldowns !== undefined && (!object(value.cooldowns) || Object.entries(value.cooldowns).some(([key, date]) => !/^[a-f0-9]{16}$/.test(key) || !validTimestamp(date)))) throw new Error(`Invalid supervisor ${phase} quota cooldowns`);
  if (value.checks !== undefined && (!Array.isArray(value.checks) || value.checks.some(check => !object(check) || !validShortText(check.command) || !Number.isSafeInteger(check.exitCode) || typeof check.testedSha !== "string" || !/^[a-f0-9]{40}$/.test(check.testedSha) || check.output !== undefined && typeof check.output !== "string"))) throw new Error(`Invalid supervisor ${phase} check records`);
  if (value.mergeChecks !== undefined && (!Array.isArray(value.mergeChecks) || value.mergeChecks.some(check => !object(check) || !validShortText(check.command) || !Number.isSafeInteger(check.exitCode) || typeof check.testedSha !== "string" || !/^[a-f0-9]{40}$/.test(check.testedSha) || check.output !== undefined && typeof check.output !== "string"))) throw new Error(`Invalid supervisor ${phase} merge check records`);
  if (value.permission !== undefined && (!object(value.permission) || !validShortText(value.permission.id) || !validShortText(value.permission.action) || typeof value.permission.sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(value.permission.sessionId))) throw new Error(`Invalid supervisor ${phase} permission checkpoint`);
  // Discard obsolete private-server PIDs without validating or ever signaling them.
  const { sdkServer: _legacyServer, ...record } = value;
  return record as PhaseCheckpoint;
}

/** Migrate legacy executor/critic checkpoints in place without replacing retained IDs or worktrees. */
export function migrateSupervisorCheckpoint<T extends SupervisorCheckpoint>(saved: T | undefined): T | SupervisorCheckpoint {
  if (!saved) return { phase: "plan", phaseStatus: "pending", phases: { plan: { status: "pending" } } };
  const { sdkServer: _legacyServer, ...checkpoint } = saved;
  if (saved.activeIteration !== undefined && (!Number.isSafeInteger(saved.activeIteration) || saved.activeIteration < 1)) throw new Error("Invalid active supervisor iteration");
  if (saved.cooldowns !== undefined && (!object(saved.cooldowns) || Object.entries(saved.cooldowns).some(([key, date]) => !/^[a-f0-9]{16}$/.test(key) || !validTimestamp(date)))) throw new Error("Invalid supervisor account/model cooldowns");
  if (saved.availability !== undefined && (!object(saved.availability) || Object.entries(saved.availability).some(([key, entry]) =>
    !/^[a-f0-9]{16}$/.test(key) || !object(entry) || !["available", "unavailable"].includes(String(entry.status)) || !validTimestamp(entry.expiresAt) ||
    entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 512)))) throw new Error("Invalid supervisor model availability cache");
  if (saved.probe !== undefined && (!object(saved.probe) || !/^[a-f0-9]{16}$/.test(String(saved.probe.candidateKey)) ||
    !validShortText(saved.probe.groupId) || !validShortText(saved.probe.provider) || !validShortText(saved.probe.model) ||
    !validShortText(saved.probe.reasoning) || !validShortText(saved.probe.credentialId) || !validShortText(saved.probe.sessionKey) ||
    typeof saved.probe.requestId !== "string" || !/^msg_[A-Za-z0-9]+$/.test(saved.probe.requestId) ||
    saved.probe.sessionId !== undefined && (typeof saved.probe.sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(saved.probe.sessionId)) ||
    !["prepared", "admitted"].includes(String(saved.probe.requestStatus)) ||
    saved.probe.transport !== undefined && saved.probe.transport !== "public" || !validTimestamp(saved.probe.startedAt))) throw new Error("Invalid supervisor disposable probe checkpoint");
  if (saved.phases !== undefined) {
    if (saved.phase !== undefined && !isPhase(saved.phase)) throw new Error("Invalid supervisor checkpoint phase");
    if (saved.phaseStatus !== undefined && !statuses.includes(saved.phaseStatus)) throw new Error("Invalid supervisor checkpoint phase status");
    const phases: Partial<Record<SupervisorPhase, PhaseCheckpoint>> = {};
    for (const phase of SUPERVISOR_PHASES) {
      const entry = saved.phases[phase];
      if (entry !== undefined) phases[phase] = validPhaseRecord(entry, phase);
    }
    const phase = isPhase(saved.phase) ? saved.phase : "plan";
    phases[phase] ??= { status: (saved.phaseStatus as PhaseStatus | undefined) || "pending" };
    return { ...checkpoint, phase, phaseStatus: phases[phase]!.status, phases };
  }

  const legacyStatus = typeof saved.status === "string" ? saved.status : "";
  const legacySession = typeof saved.openCodeSessionId === "string" ? saved.openCodeSessionId : undefined;
  const legacyPiSession = typeof saved.sessionId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(saved.sessionId);
  const implSummary = typeof saved.lastImplSummary === "string" ? saved.lastImplSummary : undefined;
  const phases: Partial<Record<SupervisorPhase, PhaseCheckpoint>> = {
    plan: { status: "complete", result: "Migrated legacy checkpoint; preserved prior issue and implementation context." },
  };
  let phase: SupervisorPhase;
  if (legacyStatus === "pass") {
    phases.implement = { status: "complete", ...(legacySession ? { sessionId: legacySession } : {}), ...(implSummary ? { result: implSummary } : {}) };
    phases.check = { status: "complete", result: "Legacy controller had already accepted this checkpoint." };
    phases.review = { status: "complete", result: typeof saved.feedback === "string" ? saved.feedback : "Legacy controller had already accepted this checkpoint." };
    phase = "done";
  } else if (legacyStatus === "reviewing" || legacyStatus === "review-first" || legacyStatus === "critic-failed") {
    // The old executor summary is already saved. Continue through the controller check, then review.
    phases.implement = { status: "complete", ...(legacySession ? { sessionId: legacySession } : {}), ...(implSummary ? { result: implSummary } : {}) };
    phases.check = { status: "pending" };
    phase = "check";
  } else if (legacySession || legacyStatus === "executing" || legacyStatus === "agent-failed") {
    phases.implement = { status: "running", ...(legacySession ? { sessionId: legacySession } : {}), ...(implSummary ? { result: implSummary } : {}) };
    phase = "implement";
  } else {
    // Legacy Pi session IDs stay in checkpoint history; SDK execution starts from saved work/summary.
    phases.plan = { status: "pending" };
    phase = "plan";
  }
  return { ...checkpoint, ...(legacyPiSession && !legacySession ? { legacyRuntime: "pi" } : {}), phase, phaseStatus: phases[phase]!.status, phases };
}

export type WorkflowOutcome = "complete" | "check-failed" | "review-feedback" | "replan";

/** Start a new turn when feedback re-enters a role, while preserving its native session and cooldowns. */
export function beginSupervisorAttempt(record: PhaseCheckpoint): PhaseCheckpoint {
  if (record.status !== "pending") return { ...record, status: "running" };
  return { ...record, status: "running", requestId: undefined, requestMessageId: undefined,
    recoveries: undefined, requestFingerprint: undefined, requestStatus: undefined, result: undefined, error: undefined,
    retryAt: undefined, permission: undefined, candidateIndex: 0 };
}

/** Keep old iteration history while ensuring a pending/replanned plan starts the next implementation attempt. */
export function supervisorIteration(state: Pick<SupervisorCheckpoint, "phase" | "activeIteration" | "phases"> & { iterations?: number }): number {
  if (Number.isSafeInteger(state.activeIteration) && Number(state.activeIteration) > 0) return Number(state.activeIteration);
  const iterations = Number.isSafeInteger(state.iterations) && Number(state.iterations) > 0 ? Number(state.iterations) : 0;
  if (state.phase === "plan") return iterations + 1;
  if (state.phase === "implement") return state.phases?.implement?.status === "complete" ? Math.max(1, iterations) : iterations + 1;
  return Math.max(1, iterations);
}

/** Return the only valid next phase for a completed phase outcome. */
export function nextSupervisorPhase(phase: SupervisorPhase, outcome: WorkflowOutcome): SupervisorPhase {
  if (phase === "plan" && outcome === "complete") return "implement";
  if (phase === "implement" && outcome === "complete") return "check";
  if (phase === "check" && outcome === "complete") return "review";
  if (phase === "check" && outcome === "check-failed") return "implement";
  if (phase === "review" && outcome === "complete") return "done";
  if (phase === "review" && outcome === "review-feedback") return "implement";
  if (phase === "review" && outcome === "replan") return "plan";
  throw new Error(`Invalid supervisor transition: ${phase} + ${outcome}`);
}

export function transitionSupervisorState<T extends SupervisorCheckpoint>(
  state: T,
  next: SupervisorPhase,
  patch: Partial<PhaseCheckpoint> = {},
  currentStatus: PhaseStatus = "complete",
): T {
  const current = state.phase;
  if (!current || !isPhase(current)) throw new Error("Supervisor checkpoint has no valid current phase");
  const allowed: Record<SupervisorPhase, SupervisorPhase[]> = {
    plan: ["implement"], implement: ["check"], check: ["review", "implement"],
    review: ["done", "implement", "plan"], done: [],
  };
  if (!allowed[current].includes(next)) throw new Error(`Invalid supervisor phase transition: ${current} -> ${next}`);
  const phases = { ...(state.phases ?? {}) };
  phases[current] = { ...(phases[current] ?? { status: "pending" }), status: currentStatus };
  phases[next] = { ...(phases[next] ?? { status: "pending" }), ...patch };
  return { ...state, phase: next, phaseStatus: phases[next]!.status, phases };
}
