package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"kbchat/backend/internal/dto"
)

func TestDocumentCountsRouteAuthenticationAndQueryContract(t *testing.T) {
	f := newStatusFixture(t)
	for _, test := range []struct {
		name, query, token string
		status             int
	}{
		{"authenticated", "?knowledgeBaseId=" + f.kbID.String() + "&status=failed&page=99", f.tokens[f.owner], http.StatusOK},
		{"anonymous", "", "", http.StatusUnauthorized},
		{"invalid scope", "?knowledgeBaseId=invalid", f.tokens[f.owner], http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/documents/counts"+test.query, nil)
			if test.token != "" {
				req.Header.Set("Authorization", "Bearer "+test.token)
			}
			rec := httptest.NewRecorder()
			f.handler.ServeHTTP(rec, req)
			if rec.Code != test.status {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
			}
			if rec.Code == http.StatusOK {
				var body dto.DocumentCountsResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.Total != 1 || body.Completed != 1 || body.Processing != 0 || body.Failed != 0 {
					t.Fatalf("unexpected counts: %#v", body)
				}
			}
		})
	}
}
