# whoelse

**Parallel coding agents merge cleanly and still break each other. whoelse tells them.**

Agent A renames `chargeCard` to `chargePayment` in one worktree. Agent B, in another, adds three calls to `chargeCard`. Both branches merge without a conflict; the build breaks. Git compares text, not meaning.

whoelse watches every worktree of a repo at the symbol level and tells the agent the moment another one removes, renames or changes something it uses, while it can still adapt.

Work in progress. Claude Code, Codex and Antigravity; TypeScript, JavaScript and Python.
