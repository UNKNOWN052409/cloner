// Task repository (spec §5): persistent task CRUD in PostgreSQL.
// Replaces the filesystem JSON store. Ownership enforced via user_id.
import { query, withTransaction } from "../database/client.js";

export async function createTask({ userId, url, options = {} }) {
  const result = await query(
    `INSERT INTO tasks (user_id, source_url, options) VALUES ($1, $2, $3) RETURNING *`,
    [userId, url, JSON.stringify(options)]
  );
  const task = result.rows[0];
  await addTaskEvent(task.id, "task.created", { url });
  return task;
}

export async function getTask(taskId, userId) {
  const result = await query(
    "SELECT * FROM tasks WHERE id = $1 AND user_id = $2",
    [taskId, userId]
  );
  return result.rows[0] || null;
}

export async function listTasks(userId, { status, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM tasks WHERE user_id = $1";
  const params = [userId];
  if (status) { sql += " AND status = $2"; params.push(status); }
  sql += " ORDER BY created_at DESC LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
  params.push(limit, offset);
  const result = await query(sql, params);
  return result.rows;
}

export async function updateTask(taskId, userId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getTask(taskId, userId);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const values = keys.map((k) => patch[k]);
  const result = await query(
    `UPDATE tasks SET ${sets}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [taskId, userId, ...values]
  );
  return result.rows[0] || null;
}

export async function deleteTask(taskId, userId) {
  await query("DELETE FROM tasks WHERE id = $1 AND user_id = $2", [taskId, userId]);
}

// stage management (spec §3: explicit stage transitions)
export async function setStage(taskId, stage, status = "in_progress", result = null, error = null) {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO task_stages (task_id, stage, status, started_at) VALUES ($1, $2, $3, now())`,
      [taskId, stage, status]
    );
    await client.query(
      `UPDATE tasks SET current_stage = $1, updated_at = now() WHERE id = $2`,
      [stage, taskId]
    );
  });
}

export async function completeStage(taskId, stage, result = null, error = null) {
  const duration = Date.now() - Date.now(); // will be computed properly
  await query(
    `UPDATE task_stages SET status = $1, completed_at = now(), result = $2, error = $3
     WHERE task_id = $4 AND stage = $5 AND status = 'in_progress'`,
    [error ? "failed" : "completed", result ? JSON.stringify(result) : null, error, taskId, stage]
  );
}

export async function getStages(taskId, userId) {
  const result = await query(
    `SELECT ts.* FROM task_stages ts JOIN tasks t ON t.id = ts.task_id
     WHERE ts.task_id = $1 AND t.user_id = $2 ORDER BY ts.created_at`,
    [taskId, userId]
  );
  return result.rows;
}

export async function addTaskEvent(taskId, eventType, payload = {}) {
  await query(
    "INSERT INTO task_events (task_id, event_type, payload) VALUES ($1, $2, $3)",
    [taskId, eventType, JSON.stringify(payload)]
  );
}

export async function getTaskEvents(taskId, userId, limit = 100) {
  const result = await query(
    `SELECT te.* FROM task_events te JOIN tasks t ON t.id = te.task_id
     WHERE te.task_id = $1 AND t.user_id = $2 ORDER BY te.created_at DESC LIMIT $3`,
    [taskId, userId, limit]
  );
  return result.rows;
}

export async function addArtifact(taskId, stage, type, storageKey, mimeType, sizeBytes, checksum) {
  await query(
    `INSERT INTO artifacts (task_id, stage, artifact_type, storage_key, mime_type, size_bytes, checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, stage, type, storageKey, mimeType, sizeBytes, checksum]
  );
}

export async function getArtifacts(taskId, userId) {
  const result = await query(
    `SELECT a.* FROM artifacts a JOIN tasks t ON t.id = a.task_id
     WHERE a.task_id = $1 AND t.user_id = $2 ORDER BY a.created_at`,
    [taskId, userId]
  );
  return result.rows;
}
