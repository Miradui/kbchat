CREATE TABLE IF NOT EXISTS document_pdf_corrections (
 document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 content JSONB NOT NULL
);
