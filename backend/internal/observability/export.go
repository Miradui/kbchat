package observability

import (
	"context"
	"net/url"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Standard dependency instrumentation can record SQL, URLs and raw exception
// messages. Redact at the single export boundary, including failed requests.
type privateExporter struct{ sdktrace.SpanExporter }

func (e privateExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	clean := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		clean[i] = privateSpan{span}
	}
	return e.SpanExporter.ExportSpans(ctx, clean)
}

type privateSpan struct{ sdktrace.ReadOnlySpan }

func (s privateSpan) Attributes() []attribute.KeyValue {
	return privateAttributes(s.ReadOnlySpan.Attributes())
}
func (s privateSpan) Status() sdktrace.Status {
	status := s.ReadOnlySpan.Status()
	status.Description = ""
	return status
}
func (s privateSpan) Events() []sdktrace.Event {
	events := append([]sdktrace.Event(nil), s.ReadOnlySpan.Events()...)
	for i := range events {
		events[i].Attributes = privateAttributes(events[i].Attributes)
	}
	return events
}

func privateAttributes(attrs []attribute.KeyValue) []attribute.KeyValue {
	clean := make([]attribute.KeyValue, 0, len(attrs))
	for _, attr := range attrs {
		switch string(attr.Key) {
		case "db.statement", "db.query.text", "db.connection_string", "exception.message", "exception.stacktrace", "url.query", "url.userinfo":
			continue
		case "http.url", "url.full", "http.target":
			u, err := url.Parse(attr.Value.AsString())
			if err != nil {
				continue
			}
			u.User, u.RawQuery, u.Fragment = nil, "", ""
			attr.Value = attribute.StringValue(u.String())
		}
		clean = append(clean, attr)
	}
	return clean
}
