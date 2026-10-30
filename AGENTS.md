# AgentLoop

AgentLoop is an experimental OpenCode-based supervisor for GitHub issue workflows.

- Run `npm install`, `npm run check`, and `npm run agentloop -- --self-test` before submitting changes.
- Preserve resumable request identity and confirm a previous writer has stopped before starting another.
- Keep GitHub, model, and deployment credentials out of source, logs, and test fixtures.
- Do not claim end-to-end completion without a real issue-to-verification run.
