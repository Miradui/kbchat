package service

import "strings"

// refusalMarker is what the model is asked to put on its own first line when it
// declines to answer for reasons of content rather than for lack of evidence.
//
// A marker is used instead of reading the prose because heuristics on refusal
// wording are wrong in both directions: "根据资料，X 不适用于 Y" is a real answer that
// reads like a refusal, and a refusal can be phrased without any keyword at all.
// Provider compliance is model-dependent; see docs/05-rag-pipeline.md.
// A missing marker is always treated as answered, so refusal counts are a lower
// bound and are not inferred from the answer's prose.
const refusalMarker = "[[NO_ANSWER]]"

// refusalPromptRules are appended to the knowledge-answer system prompt.
//
// The second line is load-bearing: without it the model also marks "the chunks do
// not cover this", which is no_basis and already handled without ever calling the
// provider. Conflating the two would blame the model for an empty knowledge base.
func refusalPromptRules() []string {
	return []string{
		"如果你因为问题内容本身不适合回答而拒绝回答，请在回复第一行单独输出 " + refusalMarker + "，再另起一行说明原因。",
		"知识片段不足不属于拒绝回答：那种情况直接说明无法从当前知识库确认即可，不要输出这个标记。",
		"正常回答时绝对不要输出这个标记。",
	}
}

// stripRefusalMarker reports whether an answer was marked as a refusal and returns
// the answer without the marker.
//
// Only a marker at the very start counts. A model that mentions the marker in the
// middle of an otherwise real answer is not refusing, and treating it as a refusal
// would discard a usable answer.
func stripRefusalMarker(answer string) (string, bool) {
	trimmed := strings.TrimSpace(answer)
	if !strings.HasPrefix(trimmed, refusalMarker) {
		return answer, false
	}
	return strings.TrimSpace(strings.TrimPrefix(trimmed, refusalMarker)), true
}

// refusalGate holds back the beginning of a stream until it can tell whether the
// answer opens with the refusal marker, so the marker never reaches the client.
//
// Only the marker's own length is ever buffered. Once the prefix cannot match, the
// buffer is released and every later delta passes straight through -- so a normal
// answer pays a few characters of delay, not a line and not the whole response.
type refusalGate struct {
	onDelta func(string) error
	buffer  strings.Builder
	decided bool
	refused bool
	// trimming is set after a marker is recognised and cleared once real text has
	// been emitted. The marker may end exactly on a delta boundary, so the
	// whitespace that separates it from the reason can arrive in a later delta than
	// the marker itself.
	trimming bool
}

func newRefusalGate(onDelta func(string) error) *refusalGate {
	return &refusalGate{onDelta: onDelta}
}

// write consumes one provider delta.
func (g *refusalGate) write(delta string) error {
	if g.decided {
		// The reason text after a marker is still what the user should see, so it
		// keeps streaming either way.
		return g.emit(delta)
	}

	g.buffer.WriteString(delta)
	pending := g.buffer.String()
	// Leading whitespace is ignored when matching, so a model that opens with a
	// newline is still recognised.
	candidate := strings.TrimLeft(pending, " \t\r\n")

	switch {
	case strings.HasPrefix(candidate, refusalMarker):
		g.decided = true
		g.refused = true
		g.trimming = true
		return g.emit(strings.TrimPrefix(candidate, refusalMarker))
	case strings.HasPrefix(refusalMarker, candidate):
		// Still a possible prefix of the marker: keep waiting for more.
		return nil
	default:
		g.decided = true
		return g.emit(pending)
	}
}

// flush releases anything still held when the stream ends, which is what happens
// when an answer is shorter than the marker.
func (g *refusalGate) flush() error {
	if g.decided {
		return nil
	}
	g.decided = true
	return g.emit(g.buffer.String())
}

func (g *refusalGate) emit(text string) error {
	if g.trimming {
		text = strings.TrimLeft(text, " \t\r\n")
		if text == "" {
			// Still only whitespace since the marker: stay in trimming mode so the
			// separator cannot leak in from a later delta.
			return nil
		}
		g.trimming = false
	}
	if text == "" || g.onDelta == nil {
		return nil
	}
	return g.onDelta(text)
}
