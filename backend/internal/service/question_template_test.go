package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"reflect"
	"strings"
	"testing"
)

func TestQuestionTemplatesPersonalCRUDAndVariableValidation(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "template-owner")
	other := createWorkspaceUser(t, f.db, "template-other")
	req := dto.SaveQuestionTemplateRequest{Title: " 产品咨询 ", Body: "请介绍 {{产品}}；{{产品}} 在 {{地区_1}} 的限制。"}
	created, err := f.chats.SaveQuestionTemplate(ctx, owner.ID, nil, req)
	if err != nil || created.Title != "产品咨询" || !reflect.DeepEqual(created.Variables, []string{"产品", "地区_1"}) {
		t.Fatalf("template: %+v %v", created, err)
	}
	id := uuid.MustParse(created.ID)
	list, err := f.chats.ListQuestionTemplates(ctx, other.ID, dto.PersonalListQuery{Page: 1, PageSize: 20})
	if err != nil || list.Total != 0 {
		t.Fatalf("private list: %+v %v", list, err)
	}
	_, err = f.chats.SaveQuestionTemplate(ctx, other.ID, &id, req)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	err = f.chats.DeleteQuestionTemplate(ctx, other.ID, id)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	req.Body = "100%_! {{名称}}"
	updated, err := f.chats.SaveQuestionTemplate(ctx, owner.ID, &id, req)
	if err != nil || updated.ID != created.ID {
		t.Fatalf("update: %+v %v", updated, err)
	}
	list, err = f.chats.ListQuestionTemplates(ctx, owner.ID, dto.PersonalListQuery{Q: "%_!", Page: 1, PageSize: 1})
	if err != nil || list.Total != 1 {
		t.Fatalf("literal search: %+v %v", list, err)
	}
	for _, body := range []string{"{{}}", "{{a", "a}}", "{{{{x}}}}", "{{bad name}}", "{{" + strings.Repeat("字", 41) + "}}", strings.Repeat("字", 12001)} {
		req.Body = body
		_, err = f.chats.SaveQuestionTemplate(ctx, owner.ID, nil, req)
		assertAppError(t, err, "VALIDATION_ERROR")
	}
	if err = f.chats.DeleteQuestionTemplate(ctx, owner.ID, id); err != nil {
		t.Fatal(err)
	}
	list, err = f.chats.ListQuestionTemplates(ctx, owner.ID, dto.PersonalListQuery{Page: 1, PageSize: 20})
	if err != nil || list.Total != 0 {
		t.Fatalf("delete: %+v %v", list, err)
	}
}
