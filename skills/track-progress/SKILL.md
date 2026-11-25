---
name: track-progress
description: Use whenever a reply will involve tool calls (even a single step) so the task-progress panel shows real progress. Report with mcp__task-progress__set_tasks instead of update_plan, TodoWrite or TaskCreate.
---

# Track progress with set_tasks

Whenever a reply involves tool calls, even a single step, show progress on the task-progress panel.

1. **Count the total first** (files, steps, items). If it can't be counted, split the work into countable sub-steps.
2. Call `mcp__task-progress__set_tasks` (load it with ToolSearch if it is deferred). Prefer it over `update_plan`, `TodoWrite` and `TaskCreate`: those have no count fields, so an in-progress task would show no real percentage.
3. An **in-progress** task must include both `total` and `done`. Calls without them are rejected.
4. Send only the tasks that changed; updates merge by `title`. Pass `reset: true` when starting a brand-new job.
5. Report between major steps, not after every small action, to keep token use low.
