package config

import (
	"reflect"
	"testing"
)

func TestSplitCommaSeparatedTrimsAndSkipsEmptyValues(t *testing.T) {
	got := splitCommaSeparated(" https://first.example.test, ,https://second.example.test  ")
	want := []string{"https://first.example.test", "https://second.example.test"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected origins %q, got %q", want, got)
	}
}
