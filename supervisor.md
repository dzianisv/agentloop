# Supervisor — production-readiness ticket loop

`scripts/supervisor.ts` drives a GitHub ticket to *closed, merged, delivered* using two
independent `pi` agents, in a loop, with human-readable output.

## Loop

```text
pick ticket (label)  ->  IMPLEMENTER (pi, minimax)  ->  REVIEWER (pi, nemotron)
                              ^                                  |
                              |          verdict != PASS          |
                              +---- reopen + feedback (resume) ---+
```

- **Implementer** runs the project skill `take-ownership`
  (`.agents/skills/take-ownership/SKILL.md`): claim → design → implement → test →
  PR (`scripts/gh-pr-create-as-app.sh`) → review coverage → merge
  (`scripts/safe-merge.sh`) → post-merge proof → close the issue.
- **Reviewer** is a *different model* that re-derives the truth from GitHub
  (`gh pr view`, `gh pr checks`, `gh issue view`, deploy workflow) and answers with a
  fixed verdict block. It does not trust the implementer's claim.
- **Failure path**: issue reopened (if the implementer closed it) and the reviewer's
  findings are pushed back into the implementer's *own* session
  (`pi --session <id>` = resume + feedback). The implementer continues; the reviewer
  re-reviews. Bounded by `--max-iterations`.

## Usage

```bash
scripts/supervisor.ts --dry-run                     # plan only, no agents
scripts/supervisor.ts --label production-readiness  # default label
scripts/supervisor.ts --issue 5563                  # one specific ticket
scripts/supervisor.ts --limit 3                     # work 3 tickets in one run
scripts/supervisor.ts --self-test                   # loop mechanics, no GitHub, no agents
```

Useful flags: `--pick oldest|newest|lowest|highest`, `--limit <n>`, `--exclude-label <l>`,
`--max-iterations <n>`, `--timeout-sec <n>`, `--implementer-model`, `--reviewer-model`,
`--fallback-model` (used when the primary model is rate limited), `--verdict-format <file>`,
`--keep-open`, `--task-id <t_xxxxxxxx>`, `--notes <file>`.

`--limit <n>` works N tickets in one run (default 1). Tickets come from `--label` +
`--pick`; a ticket that already has an OPEN PR is skipped, so a run never starts a
second agent on work already in flight. Each ticket gets its own implementer session,
state file and log; the run ends with a summary (`#issue status iterations`).

### The worktree

The agents never work in your checkout. Each run creates a git worktree next to the
repo — `../<repo-name>.supervisor` by default (`--worktree` to move it) — from
`--base` (default `origin/main`), with `node_modules` and `.env` symlinked in, and
removes it when the ticket is finished.

If the ticket is **not** finished, the worktree is KEPT (its path is logged) and the
agent's branches are pushed first, so an interrupted run never throws away work.
`--keep-worktree` keeps it in any case.

### When a run is interrupted

| flag | meaning |
|---|---|
| `--resume-session <id>` | continue the same pi session (it keeps the investigation) |
| `--timeout-sec <n>` | budget for ONE agent call (default 3600) |

A session that grew past node's heap cannot be loaded: resuming it dies with
`Ineffective mark-compacts near heap limit ... heap out of memory`. The supervisor
recognises that and starts a FRESH session with a handoff prompt that points at
where the work actually is (the branch, the commits, the PR and its comments).

### CI outage

Before the agents start, the supervisor checks the base branch's latest CI run for
the runner-outage signature (jobs that failed in under 10s with no runner and no
steps). When it matches, the implementer is told up front that CI cannot run
repo-wide, so it ships the PR instead of waiting for checks that will never go
green, and the reviewer is told to name the outage rather than calling the change
broken.

### Epics

An epic is a container of work items, not a work item: epics are skipped by default
(`--include-epics` to keep them). The leaf tickets carry the same label and are the
real queue.

Default models (OpenRouter, both free tier):

| role | model |
|---|---|
| implementer | `minimax/minimax-m3.1-flash:free` |
| reviewer | `nvidia/nemotron-3.5-super-vl:free` |

## Rate limits: the free-model fallback chain

OpenRouter's free collection (https://openrouter.ai/collections/free-models) is the
pool the supervisor rotates through. When a model answers with a rate limit, the run
**continues on the next model in the chain** — it does not wait, and it does not fail:

```text
pi <primary>  -> 429 rate limit  ->  pi <fallback 1>  ->  ...  ->  pi <fallback N>
```

- The chain is the requested model first, then the free-collection list (16
  tool-capable `:free` models, snapshot in `FREE_MODEL_FALLBACKS` in
  `scripts/supervisor.ts`).
- Rotation also triggers when a model has no endpoint / is not a valid id (a stale
  id in the chain must not kill the run).
- A rate limit is detected on the **output text**, not on the exit code: `pi` can
  exit `0` while printing an OpenRouter 429 body.
- Only when the WHOLE chain is rate limited does the script wait
  (`--retry-delay-sec`) and sweep it again, `--max-retries` times.
- The detection is deliberately tight: an agent quoting "429" in its own answer is
  not treated as a rate limit.

Flags:

| flag | meaning |
|---|---|
| `--fallback-models a,b,c` | use this chain instead of the built-in list |
| `--fallback-model <m>` | single-model alias |
| `--refresh-free-models` | re-read the live list from the OpenRouter API at start-up |
| `--check-free-models` | compare the built-in snapshot with the live collection (exit 1 on drift) |
| `--max-retries <n>` | full sweeps of the chain before giving up (default 2) |
| `--retry-delay-sec <n>` | wait between sweeps (default 60) |

Live proof of the rotation (from the PR):

```text
$ scripts/supervisor.ts --self-test-rotation --probe-model "nvidia/nemotron-3.5-super-vl:free"
probe: pi nvidia/nemotron-3.5-super-vl:free (new session ...)
probe: rate limited on nvidia/nemotron-3.5-super-vl:free — switching to the next model in the chain
probe: pi minimax/minimax-m3.1-flash:free (new session ...)
{ "ok": true, "model": "minimax/minimax-m3.1-flash:free", "output": "ROTATE_OK" }
```

Caveat worth knowing: OpenRouter's free tier has BOTH a per-model rate limit (the
usual 429, which this chain clears) and an account-wide daily quota
(`limit_source: openrouter_free_tier_daily`). Rotation clears the first; it does not
clear an exhausted daily quota. For that, point `--implementer-model` /
`--reviewer-model` at a paid model.

Exit codes: `0` PASS · `1` exhausted / agent crash / unparsable verdict · `2` usage or
missing `gh` auth · `3` a human decision is required (either agent printed
`BLOCKER:HUMAN: …`).

## Reviewer output contract

Default (`VERDICT_FORMAT` in `scripts/supervisor.ts`; override with
`--verdict-format <file>`):

```text
VERDICT: PASS|FAIL
ISSUE: #<number>
PR: #<number>|none
MERGED: yes|no
DEPLOYED: yes|no|n/a
DELIVERED: yes|no
EVIDENCE: <one line: command + key output>
BLOCKERS: <one line|none>
```

`PASS` requires PR merged **and** CI green **and** issue closed **and** delivery proven.
Anything the reviewer could not verify is a `FAIL`. A reviewer that does not emit a
parsable `VERDICT` line is nudged once, then the loop aborts (a bad reviewer answer is
never fed back to the implementer as if it were a real failure).

## Artifacts

```text
.supervisor/logs/supervisor-<repo>-<issue>-<ts>.log   # run log
.supervisor/logs/impl-<issue>-<ts>.txt                 # implementer output per iteration
.supervisor/logs/rev-<issue>-<ts>.txt                  # reviewer output per iteration
.supervisor/state-<repo>-<issue>.json                  # session id + verdicts (resumable)
```

`.supervisor/*` is gitignored.

## Guardrails baked into the implementer prompt

- never create or push a `v*` tag (that deploys prod and rolls the fleet) — stop at
  "ready for tag";
- never merge with raw `gh pr merge` (use `scripts/safe-merge.sh`);
- never hand-edit vendored `infra/lxd/**`, `infra/k3s/volume-backup/**`, `infra/ownership/**`;
- never mint a new LiteLLM key (heal the existing one);
- close the issue only with real user-facing evidence, not unit tests alone.

The supervisor itself never merges, tags or deploys.

## Notes

- OpenRouter free models share a daily request cap. A 429 is detected even when `pi`
  exits `0`, retried `--max-retries` times, and can be routed to `--fallback-model`.
- `pi` needs the project `.agents/skills/` directory, so the script must run from the
  repository root.
