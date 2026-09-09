import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, Task, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { eventBus } from '@/lib/event-bus'
import { requireAgentTaskAccess, requireWorkspaceId } from '@/lib/enforcement/workspace-scope'

const RETRYABLE_STATUSES = new Set(['failed', 'review', 'quality_review'])

function mapTaskRow(task: any) {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: task.project_prefix && task.project_ticket_no
      ? `${task.project_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
      : undefined,
  }
}

/** POST /api/tasks/[id]/retry - Requeue an existing task without deleting history. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const taskId = Number.parseInt((await params).id, 10)
    if (!Number.isInteger(taskId)) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })

    const wsResult = requireWorkspaceId(auth.user)
    if (!('workspaceId' in wsResult)) return wsResult.response
    const { workspaceId } = wsResult
    const db = getDatabase()
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as Task | undefined
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const taskDeny = requireAgentTaskAccess(auth.user, task.assigned_to ?? null)
    if (taskDeny) return taskDeny
    if (!RETRYABLE_STATUSES.has(task.status)) {
      return NextResponse.json({ error: `Task status '${task.status}' cannot be retried` }, { status: 409 })
    }

    const now = Math.floor(Date.now() / 1000)
    const previousDispatchAttempts = task.dispatch_attempts ?? 0
    const retryTx = db.transaction(() => {
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'assigned', dispatch_attempts = 0,
            retry_count = COALESCE(retry_count, 0) + 1,
            outcome = NULL, completed_at = NULL, error_message = NULL,
            updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = ?
      `).run(now, taskId, workspaceId, task.status)
      if (result.changes !== 1) return false

      db_helpers.logActivity('task_retried', 'task', taskId, auth.user.username,
        `Task retry requested: ${task.title}`, {
          previous_status: task.status,
          previous_dispatch_attempts: previousDispatchAttempts,
          retry_count: (task.retry_count ?? 0) + 1,
        }, workspaceId)
      return true
    })()
    if (!retryTx) return NextResponse.json({ error: 'Task changed before retry; try again' }, { status: 409 })
    eventBus.broadcast('task.status_changed', {
      id: taskId, status: 'assigned', previous_status: task.status,
      reason: 'manual_retry', workspace_id: workspaceId, updated_at: now,
    })

    const updatedTask = db.prepare(`
      SELECT t.*, p.name AS project_name, p.ticket_prefix AS project_prefix
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId)
    eventBus.broadcast('task.updated', { ...updatedTask, workspace_id: workspaceId })
    return NextResponse.json({ task: mapTaskRow(updatedTask) })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/tasks/[id]/retry error')
    return NextResponse.json({ error: 'Failed to retry task' }, { status: 500 })
  }
}
