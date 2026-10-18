package processor

import (
	"context"
	"encoding/json"
	"time"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/model"
)

func (p *Processor) parseDocument(ctx context.Context, document *model.Document, job *model.DocumentJob, path string, settings *tableconfig.Options) (parser.ParsedDocument, error) {
	if document.FileType == "pdf" {
		baseline, err := p.documents.PDFCorrection(ctx, document.ID)
		if err != nil {
			return parser.ParsedDocument{}, err
		}
		if len(baseline) > 0 {
			return parser.DecodePDFSnapshot(baseline)
		}
	}
	parseCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	var monitoring chan struct{}
	progress := func(summary *parser.PDFTextSummary) error {
		if monitoring == nil {
			monitoring = make(chan struct{})
			go func() {
				defer close(monitoring)
				ticker := time.NewTicker(time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-parseCtx.Done():
						return
					case <-ticker.C:
						if err := p.documents.EnsureJobRunning(parseCtx, document.ID, job.ID); err != nil {
							cancel(err)
							return
						}
					}
				}
			}()
		}
		content, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		value := parsingProgress
		if summary.OCR != nil && summary.OCR.TotalPages > 0 {
			value += 18 * summary.OCR.CompletedPages / summary.OCR.TotalPages
		}
		return p.documents.SavePDFTextSummary(parseCtx, document.ID, job.ID, content, value)
	}
	parsed, err := parser.ParseWithOptions(parseCtx, p.parser, path, document.FileType, parser.ParseOptions{TableImport: settings, OnPDFProgress: progress})
	if cause := context.Cause(parseCtx); cause != nil {
		err = cause
	}
	cancel(nil)
	if monitoring != nil {
		<-monitoring
	}
	return parsed, err
}
