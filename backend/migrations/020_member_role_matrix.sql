-- Widens knowledge_base_members.role from the two-value set created in
-- migration 009 to the viewer/editor/manager ladder the permission matrix needs.
--
-- Unlike migration 019, this one DOES rewrite existing rows. The difference is
-- that the answer here is knowable: 'member' is a single value with one meaning,
-- not free text that would have to be guessed at.
--
-- 'member' currently grants nothing at all -- it satisfies the old constraint and
-- shows up in the roster, but no authorization path consults it. Leaving those
-- rows at zero access would freeze an implementation gap into the new vocabulary,
-- so they become 'viewer': the owner did explicitly add these people to the
-- knowledge base, and read-and-ask is the least the act of adding them meant.
--
-- 'manager' keeps its name and its meaning, and gains the capabilities the matrix
-- assigns it. There is no 'owner' row to migrate: ownership comes from
-- knowledge_bases.owner_id and was always rejected on write.

-- Dropped before the UPDATE: the old constraint forbids 'viewer', so rewriting
-- the rows first would fail against it.
ALTER TABLE knowledge_base_members
DROP CONSTRAINT IF EXISTS knowledge_base_members_role_check;

UPDATE knowledge_base_members
SET role = 'viewer',
    updated_at = now()
WHERE role = 'member';

-- Any row that is neither 'manager' nor a value this migration produced would
-- block the new constraint. Rather than let the migration fail on data it cannot
-- interpret, unknown values are also collapsed to the least privileged role --
-- the same direction access.Rank fails in.
UPDATE knowledge_base_members
SET role = 'viewer',
    updated_at = now()
WHERE role NOT IN ('viewer', 'editor', 'manager');

-- Kept in sync with access.AssignableRoles; a test parses this constraint to
-- catch drift, because SQLite does not enforce CHECK and the unit tests would
-- otherwise pass with a role the database rejects.
ALTER TABLE knowledge_base_members
ADD CONSTRAINT knowledge_base_members_role_check CHECK (
    role IN (
        'viewer',
        'editor',
        'manager'
    )
);

-- Serves the membership lookup that now runs on every knowledge-base request:
-- resolve the actor's role by (knowledge_base_id, user_id). The primary key
-- already covers that exact pair, so no new index is added for it.
--
-- What is new is the reverse direction: listing the knowledge bases a user can
-- reach, which the workspace list needs once membership grants visibility.
-- idx_kb_members_user_id from 009 covers user_id alone; this one lets the join
-- read the role without touching the table.
CREATE INDEX IF NOT EXISTS idx_kb_members_user_role
ON knowledge_base_members (user_id, role);
