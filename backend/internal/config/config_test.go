package config

import (
	"reflect"
	"testing"

	"github.com/joho/godotenv"
)

func TestSplitCommaSeparatedTrimsAndSkipsEmptyValues(t *testing.T) {
	got := splitCommaSeparated(" https://first.example.test, ,https://second.example.test  ")
	want := []string{"https://first.example.test", "https://second.example.test"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected origins %q, got %q", want, got)
	}
}

func TestValidateJWTSecretRejectsUnsafeValues(t *testing.T) {
	tests := []struct {
		name   string
		secret string
	}{
		{name: "empty", secret: ""},
		{name: "whitespace", secret: "   "},
		{name: "legacy fallback", secret: "replace-with-local-secret"},
		{name: "example placeholder", secret: "change-me-to-a-long-random-secret"},
		{name: "too short", secret: "short-secret"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateJWTSecret(tt.secret); err == nil {
				t.Fatalf("expected JWT secret %q to be rejected", tt.secret)
			}
		})
	}
}

func TestValidateJWTSecretAcceptsSufficientLength(t *testing.T) {
	if err := ValidateJWTSecret("unit-test-secret-with-at-least-32-bytes"); err != nil {
		t.Fatalf("expected sufficiently long JWT secret to be accepted: %v", err)
	}
}

func TestExampleEnvironmentEnablesRerank(t *testing.T) {
	values, err := godotenv.Read("../../../.env.example")
	if err != nil {
		t.Fatalf("read example environment: %v", err)
	}
	if got := values["RERANK_ENABLED"]; got != "true" {
		t.Fatalf("expected standard RAG example to enable rerank, got %q", got)
	}
}
