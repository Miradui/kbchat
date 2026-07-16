# Backend Contract Audit

## Scope

This audit compares every business request exported by `frontend/src/api/resources.ts` with the routes, handlers, DTOs, and error responses implemented under `backend/internal`.

## Result

- The frontend has 64 normalized resource calls. They map to 63 authenticated backend routes plus the public login route.
- Every frontend HTTP method and path has a backend route. No missing endpoint or certain 404/405 remains.
- No field consumed by the frontend is missing from the corresponding backend DTO. Camel-case names and nullable fields match after the serialization fixes below.
- Pages do not bypass the shared resource/client layer with direct `fetch` calls.
- `getCurrentUser()` is currently an unused compatible export; it is not a missing backend contract.

## Corrected mismatches

`POST /api/v1/chat/sessions/:id/archive` previously returned `204 No Content`, while the frontend consumes the archived `ChatSession`. It now returns `200 OK` with the archived session, including a stable `archivedAt`. Repeating the request remains idempotent and returns the same archive timestamp.

- `ChunkListResponse` pagination fields no longer use `omitempty`, so empty result sets still return the frontend-required `total`, `page`, and `pageSize` fields.
- `ChatSessionResponse.archivedAt` no longer uses `omitempty`, so active sessions serialize the documented `archivedAt: null` instead of omitting the field.
- The frontend `ChatSession.archivedAt` field is now required and nullable, matching the backend's always-present JSON field.
- Chat session lists now join owned, non-deleted knowledge bases, preventing sessions from deleted or foreign knowledge bases from appearing as inaccessible list items.

## Documentation alignment

- `docs/04-api-design.md` now defines the archive response.
- `docs/09-error-codes.md` now includes the business errors already emitted by category, tag, member, workspace, download, and preview services.

## Verification

- Service coverage verifies ownership rejection, archive response data, list exclusion, detail retention, sequential idempotency, and overlapping concurrent archive calls returning one stable timestamp.
- Service coverage verifies chat session lists exclude foreign and soft-deleted knowledge bases.
- Router coverage verifies the authenticated HTTP endpoint returns `200` JSON and a stable `archivedAt`.
- DTO contract coverage verifies empty chunk pagination fields and explicit null `archivedAt` serialization.
- Completion requires `go test ./...`, `npm test`, `npm run build`, and `git diff --check` to pass after these changes.

No environment values, credentials, tokens, or provider configuration are recorded here.
