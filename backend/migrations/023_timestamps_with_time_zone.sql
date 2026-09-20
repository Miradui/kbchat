-- All application times represent instants. Interpret legacy timestamp values
-- as UTC, preserving their existing API meaning without repairing historical
-- offsets. Already-zoned columns are left untouched, so rerunning is safe.
DO $migration$
DECLARE
    change RECORD;
BEGIN
    FOR change IN
        SELECT table_schema, table_name,
               string_agg(
                   format('ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE %L',
                          column_name, column_name, 'UTC'),
                   ', ' ORDER BY ordinal_position
               ) AS alterations
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND data_type = 'timestamp without time zone'
          AND table_name IN (
              'users', 'user_avatars',
              'knowledge_bases', 'knowledge_base_categories',
              'knowledge_base_tags', 'knowledge_base_tag_bindings',
              'knowledge_base_members', 'knowledge_base_favorites',
              'knowledge_base_view_events', 'knowledge_base_workspace_preferences',
              'documents', 'document_jobs', 'storage_cleanup_jobs', 'document_chunks',
              'chat_sessions', 'chat_messages', 'activities',
              'evaluation_cases', 'evaluation_runs'
          )
        GROUP BY table_schema, table_name
        ORDER BY table_name
    LOOP
        EXECUTE format('ALTER TABLE %I.%I %s',
                       change.table_schema, change.table_name, change.alterations);
    END LOOP;
END
$migration$;
