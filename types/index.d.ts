export type ProgressTask = {
  id?: string
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
