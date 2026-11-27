---
name: track-progress
description: Use whenever a reply will involve tool calls (even a single step) so the task-progress panel shows real progress. Report with mcp__task-progress__set_tasks instead of update_plan, TodoWrite or TaskCreate.
---

# Track progress with set_tasks

Whenever a reply involves tool calls, even a single step, show progress on the task-progress panel.

1. **Count the total first** (files, steps, items). If it can't be counted, split the work into countable sub-steps.
   - `total` counts units you will finish **and report one by one** inside this task. If the whole task happens in one tool call (writing one script, running one command), its total is 1, even if that script processes 22 items. Otherwise `done` cannot move until the call ends, and the bar sits at 0/22 and then jumps to 100%.
   - Use the item count for the step that really handles items one at a time and reports between them.
2. Call `mcp__task-progress__set_tasks` (load it with ToolSearch if it is deferred). Prefer it over `update_plan`, `TodoWrite` and `TaskCreate`: those have no count fields, so an in-progress task would show no real percentage.
3. An **in-progress** task must include both `total` and `done`. Calls without them are rejected.
4. Send only the tasks that changed; updates merge by `title`. Pass `reset: true` when starting a brand-new job.
5. Report in stages to keep token use low (every extra report that gets its own turn re-reads the whole conversation):
   - List the whole task in **one** call at the start (all steps, the first one `in_progress` with `total` and `done`).
   - Update again **only when a stage changes** (for example, two or three related steps finished), not after every small step.
   - Send the `set_tasks` call in the **same turn as your other tool calls** whenever you can, so it does not cost an extra turn.
   - A single-step task still gets one report, sent together with the tool call itself.
