package config

import (
	"fmt"
	"regexp"
	"time"
)

type PDFOCRConfig struct {
	Enabled       bool
	TesseractPath string
	PDFToPPMPath  string
	TessdataDir   string
	Languages     string
	MaxPages      int
	MaxImageSide  int
	PageTimeout   time.Duration
	Timeout       time.Duration
}

func loadPDFOCR() PDFOCRConfig {
	return PDFOCRConfig{
		Enabled:       getEnvBool("PDF_OCR_ENABLED", false),
		TesseractPath: getEnv("PDF_OCR_TESSERACT_PATH", "tesseract"),
		PDFToPPMPath:  getEnv("PDF_OCR_PDFTOPPM_PATH", "pdftoppm"),
		TessdataDir:   getEnv("PDF_OCR_TESSDATA_DIR", ""),
		Languages:     getEnv("PDF_OCR_LANGUAGES", "chi_sim+eng"),
		MaxPages:      getEnvInt("PDF_OCR_MAX_PAGES", 40),
		MaxImageSide:  getEnvInt("PDF_OCR_MAX_IMAGE_SIDE", 3000),
		PageTimeout:   getEnvDuration("PDF_OCR_PAGE_TIMEOUT", 30*time.Second),
		Timeout:       getEnvDuration("PDF_OCR_TIMEOUT", 5*time.Minute),
	}
}

func (c PDFOCRConfig) Validate() error {
	if !c.Enabled {
		return nil
	}
	if c.MaxPages < 1 || c.MaxPages > 200 {
		return fmt.Errorf("PDF_OCR_MAX_PAGES must be between 1 and 200")
	}
	if c.MaxImageSide < 512 || c.MaxImageSide > 4096 {
		return fmt.Errorf("PDF_OCR_MAX_IMAGE_SIDE must be between 512 and 4096")
	}
	if c.PageTimeout < time.Second || c.PageTimeout > 2*time.Minute {
		return fmt.Errorf("PDF_OCR_PAGE_TIMEOUT must be between 1s and 2m")
	}
	if c.Timeout < c.PageTimeout || c.Timeout > 20*time.Minute {
		return fmt.Errorf("PDF_OCR_TIMEOUT must be at least PDF_OCR_PAGE_TIMEOUT and at most 20m")
	}
	if len(c.Languages) > 128 || !regexp.MustCompile(`^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+){0,3}$`).MatchString(c.Languages) {
		return fmt.Errorf("PDF_OCR_LANGUAGES must contain 1-4 language names joined by +")
	}
	if c.TesseractPath == "" || c.PDFToPPMPath == "" {
		return fmt.Errorf("PDF OCR executable paths must not be empty")
	}
	return nil
}
