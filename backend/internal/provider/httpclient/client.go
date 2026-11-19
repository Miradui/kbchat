// Package httpclient bounds non-streaming model responses before JSON decoding.
package httpclient

import (
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"net/http"
	"time"
)

const MaxJSONResponseBytes = 4 * 1024 * 1024

func NewJSONClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: otelhttp.NewTransport(jsonTransport{})}
}

type jsonTransport struct{}

func (jsonTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(req)
	if response != nil && response.Body != nil {
		response.Body = http.MaxBytesReader(nil, response.Body, MaxJSONResponseBytes)
	}
	return response, err
}
