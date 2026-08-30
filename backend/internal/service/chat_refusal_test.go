package service

import (
	"strings"
	"testing"
)

func TestStripRefusalMarker(t *testing.T) {
	cases := []struct {
		name        string
		answer      string
		wantAnswer  string
		wantRefused bool
	}{
		{
			name:        "marker on its own first line",
			answer:      refusalMarker + "\n该请求涉及伪造文件，无法协助。",
			wantAnswer:  "该请求涉及伪造文件，无法协助。",
			wantRefused: true,
		},
		{
			name:        "leading whitespace before the marker",
			answer:      "\n  " + refusalMarker + "\n原因说明。",
			wantAnswer:  "原因说明。",
			wantRefused: true,
		},
		{
			name:        "marker only, no reason given",
			answer:      refusalMarker,
			wantAnswer:  "",
			wantRefused: true,
		},
		{
			name:        "normal answer",
			answer:      "根据知识片段，入职满一年享有 10 天年假。",
			wantAnswer:  "根据知识片段，入职满一年享有 10 天年假。",
			wantRefused: false,
		},
		{
			// Not a refusal: a real answer that happens to name the marker is still a
			// real answer, and discarding it would lose usable content.
			name:        "marker in the middle is not a refusal",
			answer:      "文档里提到了 " + refusalMarker + " 这个标记的用途。",
			wantAnswer:  "文档里提到了 " + refusalMarker + " 这个标记的用途。",
			wantRefused: false,
		},
		{
			// The wording that looks like a refusal but is an answer. This is exactly
			// what a keyword heuristic would get wrong.
			name:        "refusal-sounding answer without the marker",
			answer:      "根据资料，该条款不适用于兼职员工，因此无法按此办理。",
			wantAnswer:  "根据资料，该条款不适用于兼职员工，因此无法按此办理。",
			wantRefused: false,
		},
		{
			name:        "empty answer",
			answer:      "",
			wantAnswer:  "",
			wantRefused: false,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			answer, refused := stripRefusalMarker(testCase.answer)
			if refused != testCase.wantRefused {
				t.Fatalf("refused = %v, want %v", refused, testCase.wantRefused)
			}
			if answer != testCase.wantAnswer {
				t.Fatalf("answer = %q, want %q", answer, testCase.wantAnswer)
			}
		})
	}
}

func TestSystemPromptCarriesRefusalRules(t *testing.T) {
	prompt := systemPrompt()
	if !strings.Contains(prompt, refusalMarker) {
		t.Fatal("system prompt must ask for the refusal marker")
	}
	// Without this rule the model also marks "the chunks do not cover this", which
	// is no_basis and never reaches the provider at all.
	if !strings.Contains(prompt, "知识片段不足不属于拒绝回答") {
		t.Fatal("system prompt must separate no_basis from refusal")
	}
}

func TestRefusalGateStripsMarkerFromStream(t *testing.T) {
	var seen strings.Builder
	gate := newRefusalGate(func(delta string) error {
		seen.WriteString(delta)
		return nil
	})

	// Split mid-marker on purpose: the marker arrives across delta boundaries in a
	// real stream, so matching cannot assume it lands in one chunk.
	for _, delta := range []string{"[[NO_", "ANSWER]]", "\n涉及", "伪造文件。"} {
		if err := gate.write(delta); err != nil {
			t.Fatalf("write delta: %v", err)
		}
	}
	if err := gate.flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	got := seen.String()
	if strings.Contains(got, refusalMarker) {
		t.Fatalf("marker leaked to the client: %q", got)
	}
	if got != "涉及伪造文件。" {
		t.Fatalf("streamed text = %q, want the reason without the marker", got)
	}
}

func TestRefusalGateTrimsSeparatorArrivingAfterTheMarker(t *testing.T) {
	var seen strings.Builder
	gate := newRefusalGate(func(delta string) error {
		seen.WriteString(delta)
		return nil
	})

	// The marker ends exactly on a delta boundary, so the newline separating it from
	// the reason arrives in a later delta than the marker itself.
	for _, delta := range []string{refusalMarker, "\n", "涉及伪造文件。"} {
		if err := gate.write(delta); err != nil {
			t.Fatalf("write delta: %v", err)
		}
	}
	if err := gate.flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	if got := seen.String(); got != "涉及伪造文件。" {
		t.Fatalf("streamed text = %q, want the reason with no leading separator", got)
	}
}

func TestRefusalGatePassesNormalAnswerThrough(t *testing.T) {
	var seen strings.Builder
	gate := newRefusalGate(func(delta string) error {
		seen.WriteString(delta)
		return nil
	})

	deltas := []string{"根据", "知识片段，", "年假为 10 天。"}
	for _, delta := range deltas {
		if err := gate.write(delta); err != nil {
			t.Fatalf("write delta: %v", err)
		}
	}
	if err := gate.flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	if got, want := seen.String(), strings.Join(deltas, ""); got != want {
		t.Fatalf("streamed text = %q, want %q", got, want)
	}
}

func TestRefusalGateFlushesAnswerShorterThanMarker(t *testing.T) {
	var seen strings.Builder
	gate := newRefusalGate(func(delta string) error {
		seen.WriteString(delta)
		return nil
	})

	// "[[" is a live prefix of the marker, so the gate is still undecided when the
	// stream ends. Without flush this answer would vanish.
	if err := gate.write("[["); err != nil {
		t.Fatalf("write delta: %v", err)
	}
	if err := gate.flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got := seen.String(); got != "[[" {
		t.Fatalf("streamed text = %q, want the buffered text released on flush", got)
	}
}
