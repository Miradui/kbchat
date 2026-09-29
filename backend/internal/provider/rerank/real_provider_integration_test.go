package rerank

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"kbchat/backend/internal/config"
	corererank "kbchat/backend/internal/rerank"
)

// Explicit opt-in: sends only synthetic documents to a real, potentially billed
// provider. Does not load application credentials or open a database.
func TestRealRerankProviderContract(t *testing.T) {
	if os.Getenv("RAG_TEST_RERANK_PROVIDER") != "1" {
		t.Skip("set RAG_TEST_RERANK_PROVIDER=1 and RAG_TEST_RERANK_* to run real model verification")
	}
	cfg := config.Config{
		RerankBaseURL: os.Getenv("RAG_TEST_RERANK_BASE_URL"),
		RerankAPIKey:  os.Getenv("RAG_TEST_RERANK_API_KEY"),
		RerankModel:   os.Getenv("RAG_TEST_RERANK_MODEL"),
	}
	if cfg.RerankBaseURL == "" || cfg.RerankAPIKey == "" || cfg.RerankModel == "" {
		t.Fatal("explicit test base URL, API key and model are required")
	}
	provider := NewOpenAICompatibleProvider(cfg)
	cases := []struct {
		name, query, expected string
		documents             []corererank.Document
	}{
		{"chinese_retention", "星桥项目的日备份保留多少天？", "daily", []corererank.Document{
			{ID: "monthly", Content: "星桥项目的月度归档保留12个月。"},
			{ID: "daily", Content: "星桥项目每天凌晨两点执行完整备份，日备份保留35天。"},
			{ID: "other", Content: "云帆项目的日备份保留7天。"},
			{ID: "unrelated", Content: "食堂每周五供应面条。"},
		}},
		{"chinese_error_code", "星河 ZX-928 出现 E-4021 错误时如何处理？", "matching-code", []corererank.Document{
			{ID: "filter", Content: "星河 ZX-928 的空气滤芯每90天更换一次。"},
			{ID: "other-code", Content: "星河 ZX-928 出现 E-5099 时，应清理风扇并更换空气滤芯。"},
			{ID: "matching-code", Content: "星河 ZX-928 出现 E-4021 时，应检查签名配置，重新同步系统时钟，然后重启认证服务。"},
			{ID: "unrelated", Content: "报销申请需附发票。"},
		}},
		{"english_retention", "How long are Aurora daily backups retained?", "aurora-daily", []corererank.Document{
			{ID: "unrelated", Content: "The cafeteria serves lunch at noon."},
			{ID: "borealis", Content: "Borealis daily backups are retained for seven days."},
			{ID: "aurora-monthly", Content: "Aurora monthly archives are retained for twelve months."},
			{ID: "aurora-daily", Content: "Aurora daily backups are retained for thirty-five days."},
		}},
	}
	for _, sample := range cases {
		t.Run(sample.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
			defer cancel()
			start := time.Now()
			results, err := provider.Rerank(ctx, sample.query, sample.documents)
			if err != nil {
				// Provider errors can contain credentials or endpoint details.
				t.Fatalf("real rerank call failed (%T)", err)
			}
			entry, _ := json.Marshal(map[string]any{"model": cfg.RerankModel, "case": sample.name, "elapsedMs": time.Since(start).Milliseconds(), "results": results})
			t.Log(string(entry))
			if len(results) != len(sample.documents) {
				t.Fatalf("got %d results for %d documents", len(results), len(sample.documents))
			}
			ids := make(map[string]bool, len(sample.documents))
			for _, document := range sample.documents {
				ids[document.ID] = true
			}
			for i, result := range results {
				if !ids[result.ID] {
					t.Errorf("unknown or repeated document ID %q", result.ID)
				}
				delete(ids, result.ID)
				if math.IsNaN(result.Score) || math.IsInf(result.Score, 0) {
					t.Error("non-finite relevance score")
				}
				if i > 0 && result.Score > results[i-1].Score {
					t.Error("scores are not in descending order")
				}
			}
			if results[0].ID != sample.expected {
				t.Errorf("top result = %q, want %q", results[0].ID, sample.expected)
			}
		})
	}
}
