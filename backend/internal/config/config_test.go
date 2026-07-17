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

func TestExampleEnvironmentEnablesRerank(t *testing.T) {
	values, err := godotenv.Read("../../../.env.example")
	if err != nil {
		t.Fatalf("read example environment: %v", err)
	}
	if got := values["RERANK_ENABLED"]; got != "true" {
		t.Fatalf("expected standard RAG example to enable rerank, got %q", got)
	}
}
