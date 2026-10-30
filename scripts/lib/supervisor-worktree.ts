import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface IssueWorktreeChoice {
  worktree: string;
  /** True when the path came from the operator or a checkpoint, so an existing directory may be adopted. */
  managed: boolean;
}

/**
 * A checkpoint is portable only when the worktree it pins still exists on this host. A checkpoint
 * copied from another machine (or one whose worktree was pruned) must fall back to the repository's
 * default sibling worktree instead of asking git to create a foreign path such as /Users/... .
 */
export function resolveIssueWorktree(input: {
  root: string;
  issue: number;
  savedWorktree?: string;
  explicitWorktree?: string;
}): IssueWorktreeChoice {
  const explicit = input.explicitWorktree?.trim() || undefined;
  const saved = input.savedWorktree && existsSync(input.savedWorktree) ? input.savedWorktree : undefined;
  const requested = explicit || saved;
  return {
    worktree: resolve(requested || `${input.root}.supervisor-${input.issue}`),
    managed: Boolean(requested || input.savedWorktree),
  };
}
