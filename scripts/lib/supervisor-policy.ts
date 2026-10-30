/** Fail-closed identity/evidence predicates; no network calls or side effects. */
export type SupervisorVerdict = {
  raw: string;
  verdict?: "PASS" | "FAIL";
  issue?: string;
  pr?: string;
  merged?: string;
  deployed?: string;
  delivered?: string;
  headSha?: string;
  mergeSha?: string;
  localTestSha?: string;
  evidence?: string;
  blockers?: string;
  needsHuman: boolean;
};

export const VERDICT_FORMAT = `VERDICT: PASS|FAIL
ISSUE: #<number>
PR: #<number>|none
HEAD_SHA: <full PR head SHA>
MERGE_SHA: <full merge SHA>
LOCAL_TEST_SHA: <full tested merge SHA>
MERGED: yes|no
DEPLOYED: yes|no|n/a
DELIVERED: yes|no
EVIDENCE: <actual acceptance command + result + target/version, or reason deployment is not applicable>
BLOCKERS: <one line|none>`;

export function parseVerdict(raw: string): SupervisorVerdict {
  const grab = (key: string): string | undefined => {
    const matches = [...raw.matchAll(new RegExp(`^\\s*${key}\\s*:[ \\t]*([^\\r\\n]+)$`, "gim"))];
    // Ambiguous blocks are not a result, including PASS followed by FAIL.
    return matches.length === 1 ? matches[0][1].trim() : undefined;
  };
  const verdict = grab("VERDICT");
  return {
    raw,
    verdict: verdict === "PASS" || verdict === "FAIL" ? verdict : undefined,
    issue: grab("ISSUE"), pr: grab("PR"),
    headSha: grab("HEAD_SHA"), mergeSha: grab("MERGE_SHA"), localTestSha: grab("LOCAL_TEST_SHA"),
    merged: grab("MERGED"), deployed: grab("DEPLOYED"), delivered: grab("DELIVERED"),
    evidence: grab("EVIDENCE"), blockers: grab("BLOCKERS"),
    needsHuman: /^\s*BLOCKER\s*:\s*HUMAN\s*:/im.test(raw),
  };
}

export type MergeIdentity = {
  number: number;
  state: string;
  headRefOid: string;
  mergeCommit: { oid: string } | null;
  baseRepository?: { nameWithOwner: string };
};

export function verdictProblems(v: SupervisorVerdict, issue: number, pr?: MergeIdentity): string[] {
  const problems: string[] = [];
  if (v.verdict !== "PASS") problems.push("reviewer did not return one exact PASS verdict");
  if (v.issue !== `#${issue}`) problems.push("reviewer issue identity does not match");
  if (!pr || v.pr !== `#${pr.number}`) problems.push("reviewer PR identity is not verified");
  if (v.merged !== "yes" || pr?.state !== "MERGED" || !pr.mergeCommit?.oid) problems.push("PR is not positively merged");
  if (v.delivered !== "yes" || !["yes", "n/a"].includes(v.deployed ?? "")) problems.push("delivery is not proven");
  const sha = /^[a-f0-9]{40}$/;
  if (!sha.test(v.headSha ?? "") || v.headSha !== pr?.headRefOid) problems.push("PR head SHA does not match");
  if (!sha.test(v.mergeSha ?? "") || v.mergeSha !== pr?.mergeCommit?.oid) problems.push("merge SHA does not match");
  if (!sha.test(v.localTestSha ?? "") || v.localTestSha !== pr?.mergeCommit?.oid) problems.push("local test evidence is not on the merge SHA");
  if (!v.evidence || /^(?:none|n\/a|unknown|not verified)$/i.test(v.evidence) || v.evidence.length < 20) problems.push("acceptance evidence is absent");
  if (v.blockers !== "none" || v.needsHuman) problems.push("there are unresolved or unspecified blockers");
  return problems;
}

export type TimelinePr = { number: number; state: string; title: string; mergedAt: string | null };
/** gh --paginate --slurp returns an array of pages, each a JSON array. */
export function parseTimelinePrs(pages: unknown): TimelinePr[] {
  if (!Array.isArray(pages)) throw new Error("issue timeline is not an array");
  const events = pages.flat();
  const out = new Map<number, TimelinePr>();
  for (const entry of events) {
    const ev = entry as { event?: string; source?: { issue?: { number?: number; state?: string; title?: string; pull_request?: { merged_at?: string | null } } } };
    const p = ev?.source?.issue;
    if (ev?.event !== "cross-referenced" || !p?.pull_request || !Number.isSafeInteger(p.number)) continue;
    out.set(p.number!, { number: p.number!, state: (p.state ?? "").toUpperCase(), title: p.title ?? "", mergedAt: p.pull_request.merged_at ?? null });
  }
  return [...out.values()];
}

export const SHIPPING_POLICY = `Follow the target repository's AGENTS.md and documented shipping policy.
Run the target repository's required checks and report actual commands, results and tested commit. Never invent evidence or suppress failures.
Use only the target repository's authorized merge and deployment procedures. Do not bypass safety gates or perform unauthorized production actions.
Reconcile existing pull requests and deployment state before retrying an operation. Preserve work and credentials; never print secrets.
Reference the issue without automatically closing it; the controller verifies acceptance before closure.`;
