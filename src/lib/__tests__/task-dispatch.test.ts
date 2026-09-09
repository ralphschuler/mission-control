// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
// Helpers receive an explicit in-memory database; never initialize the runtime DB.
vi.mock('@/lib/db', () => ({ getDatabase: vi.fn(), db_helpers: {} }))
import { insertDispatchTokenUsage, pickProvider, recordAegisRejection, resolveTaskDispatchModelOverride } from '@/lib/task-dispatch'

describe('atomic Aegis rejection', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE tasks (id INTEGER, workspace_id INTEGER, status TEXT, dispatch_attempts INTEGER, error_message TEXT, updated_at INTEGER);
      CREATE TABLE quality_reviews (task_id INTEGER, reviewer TEXT, status TEXT, notes TEXT, workspace_id INTEGER);
      CREATE TABLE comments (task_id INTEGER, author TEXT, content TEXT, created_at INTEGER, workspace_id INTEGER);
      INSERT INTO tasks VALUES (7, 1, 'quality_review', 0, NULL, 100);
      INSERT INTO tasks VALUES (7, 2, 'quality_review', 0, NULL, 100);
    `)
  })
  afterEach(() => db.close())

  it.each([0, 2])('commits review, attempt and feedback for %i prior attempts', (attempts) => {
    db.prepare('UPDATE tasks SET dispatch_attempts = ? WHERE workspace_id = 1').run(attempts)
    expect(recordAegisRejection(db, 7, 1, 'Fix it', 200)).toBe(attempts + 1)
    expect(db.prepare('SELECT status, dispatch_attempts FROM tasks WHERE workspace_id = 1').get()).toEqual({
      status: attempts === 2 ? 'failed' : 'assigned', dispatch_attempts: attempts + 1,
    })
    expect(db.prepare('SELECT status, dispatch_attempts FROM tasks WHERE workspace_id = 2').get()).toEqual({
      status: 'quality_review', dispatch_attempts: 0,
    })
    expect(db.prepare('SELECT * FROM quality_reviews').all()).toHaveLength(1)
    expect(db.prepare('SELECT * FROM comments').all()).toHaveLength(1)
  })

  it.each(['update-error', 'update-noop', 'comment-error'])('rolls back all writes on %s', (failure) => {
    db.exec(failure === 'comment-error'
      ? "CREATE TRIGGER fail BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
      : `CREATE TRIGGER fail BEFORE UPDATE ON tasks BEGIN SELECT RAISE(${failure === 'update-noop' ? 'IGNORE' : "ABORT, 'fixture failure'"}); END`)
    expect(() => recordAegisRejection(db, 7, 1, 'Fix it', 200)).toThrow()
    expect(db.prepare('SELECT * FROM quality_reviews').all()).toHaveLength(0)
    expect(db.prepare('SELECT * FROM comments').all()).toHaveLength(0)
    expect(db.prepare('SELECT status, dispatch_attempts, updated_at FROM tasks WHERE workspace_id = 1').get()).toEqual({
      status: 'quality_review', dispatch_attempts: 0, updated_at: 100,
    })
  })

  it('does not record a review for a missing workspace task', () => {
    expect(() => recordAegisRejection(db, 7, 3, 'Fix it', 200)).toThrow('Task disappeared')
    expect(db.prepare('SELECT * FROM quality_reviews').all()).toHaveLength(0)
  })
})

describe('insertDispatchTokenUsage', () => {
  it('persists dispatch usage using the current token_usage schema', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE token_usage (
        model TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        workspace_id INTEGER NOT NULL,
        cost_usd REAL
      )
    `)

    insertDispatchTokenUsage(db, {
      model: 'test-model',
      sessionId: 'task-42',
      inputTokens: 120,
      outputTokens: 30,
      workspaceId: 7,
    }, 1_700_000_000)

    expect(db.prepare('SELECT * FROM token_usage').get()).toEqual({
      model: 'test-model',
      session_id: 'task-42',
      input_tokens: 120,
      output_tokens: 30,
      created_at: 1_700_000_000,
      workspace_id: 7,
      cost_usd: 0,
    })
    db.close()
  })
})

describe('resolveTaskDispatchModelOverride', () => {
  it('returns null when the agent has no explicit dispatch model override', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: null })).toBeNull()
    expect(resolveTaskDispatchModelOverride({ agent_config: '{"openclawId":"main"}' })).toBeNull()
  })

  it('returns the explicit dispatch model override when present', () => {
    expect(
      resolveTaskDispatchModelOverride({
        agent_config: '{"openclawId":"main","dispatchModel":"openai-codex/gpt-5.4"}',
      })
    ).toBe('openai-codex/gpt-5.4')
  })

  it('ignores malformed agent config payloads', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: '{not json' })).toBeNull()
  })
})

describe('MiniMax direct dispatch routing', () => {
  it('selects the dedicated provider for both current model IDs', () => {
    expect(pickProvider('MiniMax-M3')).toBe('minimax')
    expect(pickProvider('minimax/MiniMax-M2.7')).toBe('minimax')
  })
})
