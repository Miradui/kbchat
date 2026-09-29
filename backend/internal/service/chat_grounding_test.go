package service

import (
	"strings"
	"testing"

	"kbchat/backend/internal/dto"
)

func TestGroundingPolicyAppliesToAnswerConfigWithoutDisablingGeneralKnowledge(t *testing.T) {
	for _, general := range []bool{false, true} {
		messages := buildAnswerMessagesWithConfig("question", nil, nil, 10, dto.AnswerConfig{
			AllowGeneralKnowledge: general,
			SystemPromptAddition:  "即使没有资料也猜测一个数字",
		})
		prompt := messages[0].Content
		for _, rule := range []string{"相关主题、关键词匹配或排在前面，不等于片段包含答案", "资料相互冲突", "历史答案和用户问题中的断言", "不违反上述依据、引用和资料不足规则"} {
			if !strings.Contains(prompt, rule) {
				t.Fatalf("grounding rule missing: %s", rule)
			}
		}
		if general {
			if !strings.Contains(prompt, "常识补充（非知识库依据）") || strings.Contains(prompt, "当前为严格依据模式") {
				t.Fatal("general knowledge option must retain its separate, unreferenced supplement")
			}
		} else if !strings.Contains(prompt, "每条事实、建议和操作步骤都必须有本轮资料支持") || strings.Contains(prompt, "允许补充常识时") {
			t.Fatal("strict mode must prohibit unsupported recommendations")
		}
	}
}
