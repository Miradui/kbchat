package access

// Capability is one thing a caller may attempt on a knowledge base.
//
// Capabilities are named after the action, not after the endpoint, so several
// routes can share one and a route can be moved without renaming anything.
type Capability string

const (
	// CapKnowledgeBaseRead covers the knowledge base itself: detail, stats, list
	// visibility, favourites, view history.
	CapKnowledgeBaseRead Capability = "kb.read"
	// CapKnowledgeBaseSearch covers retrieval against the knowledge base, both the
	// per-base search endpoint and inclusion in global search results.
	CapKnowledgeBaseSearch Capability = "kb.search"
	// CapKnowledgeBaseWrite covers the container's own settings: name, description,
	// category, tags, visibility.
	CapKnowledgeBaseWrite Capability = "kb.write"
	// CapKnowledgeBaseDelete covers soft-deleting and restoring the knowledge base.
	// Owner-only: deleting the container is not the same act as tidying what is
	// inside it, and a delegated manager should not be able to remove the thing
	// they were delegated over.
	CapKnowledgeBaseDelete Capability = "kb.delete"

	// CapDocumentRead covers the document list, detail, preview and chunks.
	CapDocumentRead Capability = "document.read"
	// CapDocumentDownload covers fetching the original uploaded file.
	//
	// Editor rather than viewer, and the line is not "may see the content": a
	// viewer already reads the indexed text through chunks and citations. The
	// original file carries more than the index does -- tracked changes,
	// comments, embedded objects, author metadata -- none of which is chunked.
	CapDocumentDownload Capability = "document.download"
	// CapContentWrite covers upload, replace, metadata edits, reprocessing, soft
	// delete and restore.
	CapContentWrite Capability = "content.write"
	// CapContentPurge covers the permanent-delete endpoints, single and bulk.
	//
	// Manager rather than owner: purging is irreversible, but making the owner the
	// only person who can empty a recycle bin defeats delegation. Removing the
	// whole knowledge base stays owner-only under CapKnowledgeBaseDelete.
	CapContentPurge Capability = "content.purge"

	// CapChatUse covers sessions and asking questions. It authorizes access to the
	// knowledge base; ownership of an individual session is still checked
	// separately against chat_sessions.user_id.
	CapChatUse Capability = "chat.use"
	// CapChatExport covers exporting a session transcript, which is the caller's
	// own session in every case.
	CapChatExport Capability = "chat.export"
	// CapFeedbackWrite covers rating an answer the caller received.
	CapFeedbackWrite Capability = "feedback.write"

	// CapQualityRead covers the operational quality endpoints.
	//
	// Manager rather than editor because this data aggregates what *other people*
	// asked and how they rated the answers. That is a step beyond editing content:
	// it exposes colleagues' usage.
	CapQualityRead Capability = "quality.read"

	// CapMembersRead covers reading the permission roster.
	CapMembersRead Capability = "members.read"
	// CapMembersWrite covers adding, updating and removing members.
	CapMembersWrite Capability = "members.write"
)

// minRole maps each capability to the lowest role that holds it.
//
// This map is the phase's source of truth. A capability missing from it is
// treated as owner-only by MinRole, and TestEveryCapabilityHasAMinimumRole fails
// the build rather than letting the omission become a silent grant.
var minRole = map[Capability]Role{
	CapKnowledgeBaseRead:   RoleViewer,
	CapKnowledgeBaseSearch: RoleViewer,
	CapChatUse:             RoleViewer,
	CapChatExport:          RoleViewer,
	CapFeedbackWrite:       RoleViewer,
	CapDocumentRead:        RoleViewer,

	CapDocumentDownload: RoleEditor,
	CapContentWrite:     RoleEditor,

	CapContentPurge:       RoleManager,
	CapQualityRead:        RoleManager,
	CapMembersRead:        RoleManager,
	CapMembersWrite:       RoleManager,
	CapKnowledgeBaseWrite: RoleManager,

	CapKnowledgeBaseDelete: RoleOwner,
}

// Capabilities is every capability this build knows about, used by the matrix
// tests and by the response that tells a client what the current user may do.
var Capabilities = []Capability{
	CapKnowledgeBaseRead,
	CapKnowledgeBaseSearch,
	CapKnowledgeBaseWrite,
	CapKnowledgeBaseDelete,
	CapDocumentRead,
	CapDocumentDownload,
	CapContentWrite,
	CapContentPurge,
	CapChatUse,
	CapChatExport,
	CapFeedbackWrite,
	CapQualityRead,
	CapMembersRead,
	CapMembersWrite,
}

// MinRole reports the lowest role holding a capability. An unknown capability
// resolves to RoleOwner, so forgetting to register one denies rather than grants.
func MinRole(capability Capability) Role {
	if role, ok := minRole[capability]; ok {
		return role
	}
	return RoleOwner
}

// Allows reports whether a role holds a capability.
func Allows(role Role, capability Capability) bool {
	return AtLeast(role, MinRole(capability))
}

// AllowedCapabilities lists what a role may do, in the order of Capabilities.
//
// Returns a non-nil empty slice for RoleNone so the JSON field is `[]` rather
// than `null`: a client reading `null` as "unknown" would have to special-case it.
func AllowedCapabilities(role Role) []Capability {
	allowed := make([]Capability, 0, len(Capabilities))
	for _, capability := range Capabilities {
		if Allows(role, capability) {
			allowed = append(allowed, capability)
		}
	}
	return allowed
}

// MemberRolesWith lists the stored member roles that hold a capability, as the
// strings the role column contains.
//
// Cross-knowledge-base lists cannot authorize row by row: they have to express
// reachability inside the query. This turns a capability into the role values such
// a query filters on, so those queries stay derived from the matrix instead of
// carrying a second, drifting copy of it. RoleOwner is excluded because an owner has
// no member row; queries pair this with their own owner_id predicate.
func MemberRolesWith(capability Capability) []string {
	roles := make([]string, 0, len(AssignableRoles))
	for _, role := range AssignableRoles {
		if Allows(role, capability) {
			roles = append(roles, string(role))
		}
	}
	return roles
}
