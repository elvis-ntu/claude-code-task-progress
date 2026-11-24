export type ProgressTask = {
  id?: string
  /** 真實進度 0-99，只有進行中的任務、且有回報時才有 */
  pct?: number
  title: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt: number | null
  doneAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: ProgressTask[] }
  }
}
