export type ProgressTask = {
  id?: string
  /** Real progress 0-99; only present for an in-progress task that reported counts */
  pct?: number
  /** Finished and total counts of an in-progress task (required by set_tasks) */
  done?: number
  total?: number
  title: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt: number | null
  doneAt: number | null
  /** Set at the end of a turn for a task that never started: the model forgot to report it */
  unsettled?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: ProgressTask[]; turnStartedAt: number | null; tick: number }
  }
}
