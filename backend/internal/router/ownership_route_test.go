package router

import (
	"kbchat/backend/internal/model"
	"net/http"
	"testing"
)

func TestAdminTransferKnowledgeBasesRoute(t *testing.T) {
	f := newAdminUsersFixture(t)
	kb := model.KnowledgeBase{Name: "transfer", OwnerID: f.target.ID}
	if err := f.db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/admin/users/" + f.target.ID.String() + "/transfer-knowledge-bases"
	body := `{"newOwnerId":"` + f.user.ID.String() + `","keepPreviousOwnerAsManager":false}`
	for _, test := range []struct {
		token string
		want  int
	}{{"", 401}, {f.userToken, 403}, {f.adminToken, 200}} {
		rec := f.request(t, http.MethodPost, path, body, test.token)
		if rec.Code != test.want {
			t.Fatalf("%d want %d: %s", rec.Code, test.want, rec.Body.String())
		}
	}
	if err := f.db.First(&kb, "id = ?", kb.ID).Error; err != nil {
		t.Fatal(err)
	}
	if kb.OwnerID != f.user.ID {
		t.Fatalf("owner %s", kb.OwnerID)
	}
}
