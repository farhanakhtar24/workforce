-- 20261125000100_query_data_rls
--
-- DB-ENFORCED isolation for the `query_data` agent surface (pre-Phase 6 fix):
-- the query role can no longer read Better Auth rows, cross-user tenant rows,
-- or bypass anything by rewriting its own GUCs.
--
-- Design (all idempotent, forward-only, NEVER edited after apply):
-- 1. `workforce_query_reader`: NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--    NOINHERIT, and explicitly NOT BYPASSRLS. It cannot even authenticate;
--    it exists only as a `SET LOCAL ROLE` member of the APPLICATION roles,
--    so it can never become a login path.
-- 2. Membership is granted to the role that applies this migration
--    (CURRENT_USER — the API's DATABASE_URL role in production) and, when
--    present, to the conventional app/dev role names. Production note: if
--    the API connects with a different role than the migrator, an operator
--    must run `GRANT workforce_query_reader TO <api_role>;` once — the role
--    is useless (and every query_data call then returns 503) without
--    membership, which is the fail-closed direction.
-- 3. Grants: USAGE on public + SELECT on EXACTLY the nine data tables the
--    tool is allowed to read. There are deliberately NO grants on the Better
--    Auth tables ("User", "Session", "Account", "Verification",
--    "UserSettings") — reads there fail with insufficient_privilege, loudly.
-- 4. RLS is ENABLED (NOT FORCE) on the same tables: the application/table
--    owner connections bypass exactly as before (adapters, embedding jobs,
--    compaction), while `workforce_query_reader` — a non-owner role — is
--    fully subject to every policy below.
-- 5. Policies are SELECT-only, scoped TO the query reader, and bound to the
--    transaction-local GUCs the API sets (NULL when unset → zero rows, so
--    unset settings fail closed):
--      - "WorkDoc" / "Delegation" / "AgentTask" / "AgentTaskExecution":
--        ownerId = current_setting('workforce.user_id', true) — legacy
--        ownerless rows (NULL ownerId) never match.
--      - "MemoryBlock": scope = current_setting('workforce.memory_scope',
--        true) — the userMemoryScope(owner) value; the legacy `default`
--        scope never matches.
--    Child rows go through EXISTS parent policies, and those parent
--    sub-selects are THEMSELVES subject to the parent RLS, so a child row
--    can never be read past its parent's owner/scope boundary.
-- 6. Deny the GUC-mutation vector AT THE DATABASE: EXECUTE on
--    `pg_catalog.set_config` is revoked from PUBLIC and re-granted ONLY to
--    the migrator + the conventional app roles (the query reader NEVER gets
--    it), so a single user SELECT cannot re-point the owner/scope settings.
--    The API layer keeps its token-level screen on top (belt and braces).
--    `current_setting` stays readable — it cannot change any state.
-- 7. The statements the query path runs remain exactly:
--      BEGIN READ ONLY; SET LOCAL statement_timeout; SET LOCAL
--      workforce.user_id; SET LOCAL workforce.memory_scope; SET LOCAL ROLE
--      workforce_query_reader; SELECT * FROM (<user SELECT>) LIMIT cap+1;
--    COMMIT/ROLLBACK — SET LOCAL reverts everything on transaction end.

-- ---------------------------------------------------------------------------
-- 1. The non-bypassable, non-login query role
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'workforce_query_reader') THEN
    CREATE ROLE workforce_query_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    -- Idempotent hardening: the role must never hold bypass or login flags.
    IF (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'workforce_query_reader') THEN
      ALTER ROLE workforce_query_reader NOBYPASSRLS;
    END IF;
    IF (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'workforce_query_reader') THEN
      ALTER ROLE workforce_query_reader NOLOGIN;
    END IF;
    IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'workforce_query_reader') THEN
      RAISE EXCEPTION 'workforce_query_reader must not be a superuser';
    END IF;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Membership for the migrator (CURRENT_USER) + conventional app roles
-- ---------------------------------------------------------------------------
GRANT workforce_query_reader TO CURRENT_USER;

DO $$
DECLARE
  candidate text;
BEGIN
  FOR candidate IN SELECT rolname FROM pg_catalog.pg_roles
                   WHERE rolname IN ('workforce', 'workforce_api')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = m.member
      WHERE parent.rolname = 'workforce_query_reader' AND member.rolname = candidate
    ) THEN
      EXECUTE format('GRANT workforce_query_reader TO %I', candidate);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants: schema usage + SELECT on exactly the intended data tables
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO workforce_query_reader;

GRANT SELECT ON public."WorkDoc" TO workforce_query_reader;
GRANT SELECT ON public."WorkDocVersion" TO workforce_query_reader;
GRANT SELECT ON public."WorkDocRevision" TO workforce_query_reader;
GRANT SELECT ON public."WorkDocLink" TO workforce_query_reader;
GRANT SELECT ON public."Delegation" TO workforce_query_reader;
GRANT SELECT ON public."AgentTask" TO workforce_query_reader;
GRANT SELECT ON public."AgentTaskExecution" TO workforce_query_reader;
GRANT SELECT ON public."MemoryBlock" TO workforce_query_reader;
GRANT SELECT ON public."MemoryRelation" TO workforce_query_reader;

-- Deliberately ABSENT: public."User", public."Session", public."Account",
-- public."Verification", public."UserSettings" — the auth tables are NOT
-- readable by the query role (any leak attempt fails with
-- insufficient_privilege instead of returning rows).

-- ---------------------------------------------------------------------------
-- 4. Enable (NOT FORCE) RLS on exactly those tables:
--    the table-owner (application) connections keep working unchanged,
--    workforce_query_reader is fully policy-bound.
-- ---------------------------------------------------------------------------
ALTER TABLE public."WorkDoc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkDocVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkDocRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkDocLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Delegation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AgentTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AgentTaskExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MemoryBlock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MemoryRelation" ENABLE ROW LEVEL SECURITY;

-- (Deliberate omission: no `FORCE ROW LEVEL SECURITY` anywhere — the
-- application connects as the table owner and must keep bypassing; the QUERY
-- READER is a non-owner role, so the policies below bind it regardless.)

-- ---------------------------------------------------------------------------
-- 5. Policies (SELECT-only, TO the query reader, GUC-bound)
-- ---------------------------------------------------------------------------
-- Parent tenant tables: the owner/scope GUC binding.
DROP POLICY IF EXISTS workforce_workdoc_owner ON public."WorkDoc";
CREATE POLICY workforce_workdoc_owner ON public."WorkDoc"
  FOR SELECT TO workforce_query_reader
  USING ("ownerId" = current_setting('workforce.user_id', true));

DROP POLICY IF EXISTS workforce_delegation_owner ON public."Delegation";
CREATE POLICY workforce_delegation_owner ON public."Delegation"
  FOR SELECT TO workforce_query_reader
  USING ("ownerId" = current_setting('workforce.user_id', true));

DROP POLICY IF EXISTS workforce_agenttask_owner ON public."AgentTask";
CREATE POLICY workforce_agenttask_owner ON public."AgentTask"
  FOR SELECT TO workforce_query_reader
  USING ("ownerId" = current_setting('workforce.user_id', true));

DROP POLICY IF EXISTS workforce_agenttaskexecution_owner ON public."AgentTaskExecution";
CREATE POLICY workforce_agenttaskexecution_owner ON public."AgentTaskExecution"
  FOR SELECT TO workforce_query_reader
  USING ("ownerId" = current_setting('workforce.user_id', true));

DROP POLICY IF EXISTS workforce_memoryblock_scope ON public."MemoryBlock";
CREATE POLICY workforce_memoryblock_scope ON public."MemoryBlock"
  FOR SELECT TO workforce_query_reader
  USING ("scope" = current_setting('workforce.memory_scope', true));

-- Child tables: visible only when their PARENT is visible (the EXISTS
-- sub-selects inherit the parent RLS, so ownership composes).
DROP POLICY IF EXISTS workforce_workdocversion_parent ON public."WorkDocVersion";
CREATE POLICY workforce_workdocversion_parent ON public."WorkDocVersion"
  FOR SELECT TO workforce_query_reader
  USING (
    EXISTS (
      SELECT 1
      FROM public."WorkDoc"
      WHERE public."WorkDoc"."id" = public."WorkDocVersion"."documentId"
    )
  );

DROP POLICY IF EXISTS workforce_workdocrevision_parent ON public."WorkDocRevision";
CREATE POLICY workforce_workdocrevision_parent ON public."WorkDocRevision"
  FOR SELECT TO workforce_query_reader
  USING (
    EXISTS (
      SELECT 1
      FROM public."WorkDoc"
      WHERE public."WorkDoc"."id" = public."WorkDocRevision"."documentId"
    )
  );

DROP POLICY IF EXISTS workforce_workdoclink_parent ON public."WorkDocLink";
CREATE POLICY workforce_workdoclink_parent ON public."WorkDocLink"
  FOR SELECT TO workforce_query_reader
  USING (
    EXISTS (
      SELECT 1
      FROM public."WorkDoc"
      WHERE public."WorkDoc"."id" = public."WorkDocLink"."documentId"
    )
  );

DROP POLICY IF EXISTS workforce_memoryrelation_scope ON public."MemoryRelation";
CREATE POLICY workforce_memoryrelation_scope ON public."MemoryRelation"
  FOR SELECT TO workforce_query_reader
  USING (
    EXISTS (
      SELECT 1
      FROM public."MemoryBlock"
      WHERE public."MemoryBlock"."id" = public."MemoryRelation"."sourceId"
    )
    AND
    EXISTS (
      SELECT 1
      FROM public."MemoryBlock"
      WHERE public."MemoryBlock"."id" = public."MemoryRelation"."targetId"
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Deny the GUC-mutation vector for the query role, at the database.
--    set_config is the ONLY way a single SELECT can change a GUC (SET is not
--    part of an expression). Revoke from PUBLIC, re-grant ONLY to operators
--    and application principals — NEVER to workforce_query_reader. The
--    memory/pgvector HNSW tuning keeps working because the app principal is
--    re-granted explicitly.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;

DO $$
DECLARE
  candidate text;
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO CURRENT_USER';
  FOR candidate IN SELECT rolname FROM pg_catalog.pg_roles
                   WHERE rolname IN ('workforce', 'workforce_api', 'postgres')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO %I', candidate);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Runtime verification (fails the migration loudly on drift)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  table_name text;
  missing integer;
BEGIN
  IF (SELECT COUNT(*) FROM pg_catalog.pg_tables
      WHERE schemaname = 'public' AND tablename IN ('User', 'Session', 'Account', 'Verification', 'UserSettings')
        AND has_table_privilege('workforce_query_reader', quote_ident(schemaname) || '.' || quote_ident(tablename), 'SELECT')) > 0 THEN
    RAISE EXCEPTION 'workforce_query_reader must not hold SELECT on any auth table';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_auth_members m ON m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'pg_read_all_data')
    WHERE m.member = r.oid AND r.rolname = 'workforce_query_reader'
  ) THEN
    RAISE EXCEPTION 'workforce_query_reader must not be a member of pg_read_all_data';
  END IF;

  FOR table_name IN SELECT unnest(ARRAY['WorkDoc', 'WorkDocVersion', 'WorkDocRevision', 'WorkDocLink', 'Delegation', 'AgentTask', 'AgentTaskExecution', 'MemoryBlock', 'MemoryRelation'])
  LOOP
    SELECT COUNT(*) INTO missing FROM pg_catalog.pg_class c
    WHERE c.relname = table_name
      AND c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public')
      AND c.relrowsecurity IS NOT TRUE;
    IF missing > 0 THEN
      RAISE EXCEPTION 'RLS must be ENABLED on %', table_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND tablename = table_name
        AND policyname LIKE 'workforce_%' AND roles = '{workforce_query_reader}'
    ) THEN
      RAISE EXCEPTION 'RLS policy for % is missing', table_name;
    END IF;
  END LOOP;
END
$$;
