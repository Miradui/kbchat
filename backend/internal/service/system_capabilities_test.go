package service

import (
	"encoding/json"
	"testing"

	"kbchat/backend/internal/config"
)

func TestSystemCapabilitiesChatModelsAlwaysArray(t *testing.T) {
	for _, models := range [][]string{nil, {}, {"test-model"}} {
		service := NewSystemService(config.Config{ChatAllowedModels: models})
		capabilities := service.Capabilities()
		content, err := json.Marshal(capabilities)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(content, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["chatModels"]) == "null" || capabilities.ChatModels == nil {
			t.Fatalf("empty model choices must remain an array: %s", content)
		}
		if len(models) > 0 {
			capabilities.ChatModels[0] = "mutated-response"
			if models[0] != "test-model" {
				t.Fatal("response changed the configured models")
			}
		}
	}
}
