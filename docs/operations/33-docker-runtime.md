# WingOps operations: docker runtime

## Purpose

This runbook records the production contract for WingOps task assignment, field execution, attachment upload, and event history. The state machine remains enforced at the API boundary and is persisted through the repository abstraction.

## Checks

- Authenticate the request and validate task payloads before making state changes.
- Re-check assignee ownership and the current task state inside the transition handler.
- Use the prefixed Supabase tables and JSONB event metadata from sql/postgres-schema.sql.
- Keep POSTGRES_ROUTES_ENABLED=true explicit when switching from SQLite to managed persistence.

## Failure handling

Treat a stale task state, duplicate acceptance, or storage timeout as a retryable operational event. Preserve the event history and correlation identifier; do not repair task state with direct SQL outside the repository.

## Verification

Run 
pm test, 
pm run lint, and 
pm run build. Production checks should cover registration, login, task creation, acceptance, status transitions, attachment signing, and event reads.
