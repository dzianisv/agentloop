# AgentLoop

An experimental AI coding agent supervisor for GitHub issues. AgentLoop uses OpenCode to plan, implement, check, and review work, retaining checkpoints so interrupted runs can resume.

```text
GitHub issue → plan → implement → check → review
```

## Get started

Requires Node.js 22+, Git, [GitHub CLI](https://cli.github.com/) authenticated with access to the target repository, and a configured [OpenCode](https://opencode.ai/) provider.

```bash
git clone https://github.com/dzianisv/agentloop.git
cd agentloop && npm install
cd /path/to/your/repository
/path/to/agentloop/node_modules/.bin/tsx /path/to/agentloop/scripts/supervisor.ts --issue 123 --keep-open
```

**Early prototype:** extracted from an AgentPod-specific workflow. Target repositories currently need its `pnpm` gate scripts and delivery conventions. Review permissions and model settings before running; fully autonomous issue completion is not yet verified.
