/**
 * Fastpath layer entry points. Exposed to the rest of the CLI via this barrel.
 */

export { type CloseTaskOptions, runCloseTaskCommand } from './closeTask.js';
export { type DiscardTaskOptions, runDiscardTaskCommand } from './discardTask.js';
export { parseEditorTemplate, resolveEditorCommand } from './editor.js';
export { type FastpathRunOptions, type FastpathRunResult, runFastpathTask } from './runTask.js';
export { listTaskAliases, readTaskAlias } from './taskAlias.js';
export {
  runTaskInspectCommand,
  runTaskListCommand,
  runTaskStatusCommand,
  type TaskInspectOptions,
  type TaskListOptions,
  type TaskStatusOptions,
} from './taskCommands.js';
export { isTaskId, normalizeTaskId } from './taskId.js';
export { TASK_ID_RE, type TaskAlias, type TaskId, type TaskInput } from './types.js';
