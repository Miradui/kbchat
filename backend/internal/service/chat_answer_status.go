package service

// The closed set written to chat_messages.answer_status. Kept in sync with the
// CHECK constraint in migrations/019_document_versions_and_answer_status.sql.
//
// These three failure modes look identical to a user today -- every one of them
// arrives as a paragraph saying the question could not be answered -- but they
// need different responses. AnswerStatusNoBasis means the knowledge base is
// missing content and someone should upload it. AnswerStatusRetrievalFailed means
// the system is broken and the same question will work later. AnswerStatusModelRefused
// means the provider declined, which is neither of the other two.
const (
	// AnswerStatusAnswered is the normal case: the assistant produced an answer
	// grounded in retrieved content, or a conversational reply that needs none.
	AnswerStatusAnswered = "answered"
	// AnswerStatusNoBasis means retrieval succeeded and returned nothing usable.
	// The knowledge base genuinely does not cover the question.
	AnswerStatusNoBasis = "no_basis"
	// AnswerStatusRetrievalFailed means retrieval itself errored, so whether the
	// knowledge base covers the question is unknown. Reporting this as no_basis
	// would send the user to upload content they may already have.
	AnswerStatusRetrievalFailed = "retrieval_failed"
	// AnswerStatusModelRefused means the provider declined to answer from content
	// that was retrieved and supplied. The gap is not in the knowledge base.
	AnswerStatusModelRefused = "model_refused"
)
