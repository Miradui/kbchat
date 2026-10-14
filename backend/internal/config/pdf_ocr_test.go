package config

import (
	"testing"
	"time"
)

func TestPDFOCRConfigDefaultsAndLimits(t *testing.T) {
	t.Setenv("PDF_OCR_ENABLED", "true")
	t.Setenv("PDF_OCR_LANGUAGES", "chi_sim+eng")
	cfg := loadPDFOCR()
	if !cfg.Enabled || cfg.MaxPages != 40 || cfg.MaxImageSide != 3000 || cfg.Validate() != nil {
		t.Fatalf("invalid OCR defaults: %#v", cfg)
	}
	for _, change := range []func(*PDFOCRConfig){
		func(c *PDFOCRConfig) { c.MaxPages = 0 }, func(c *PDFOCRConfig) { c.MaxPages = 201 }, func(c *PDFOCRConfig) { c.MaxImageSide = 4097 },
		func(c *PDFOCRConfig) { c.PageTimeout = 0 }, func(c *PDFOCRConfig) { c.Timeout = 21 * time.Minute }, func(c *PDFOCRConfig) { c.Timeout = time.Second },
		func(c *PDFOCRConfig) { c.Languages = "../../eng" }, func(c *PDFOCRConfig) { c.Languages = "eng --psm 3" }, func(c *PDFOCRConfig) { c.Languages = "eng+" },
	} {
		copy := cfg
		change(&copy)
		if copy.Validate() == nil {
			t.Fatalf("accepted invalid config: %#v", copy)
		}
	}
}
