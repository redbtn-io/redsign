import React, { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@redbtn/redstyle';
import '../utils/setupPdf'; // import worker setup

import { PDFView } from '../components/PDFView';
import EnvelopeComposer from '../components/EnvelopeComposer';
import { Breakpoint } from '../types/breakpoint';

// 'preview' = the original self-sign preview (unchanged); 'compose' = the
// Phase 2b sender flow (signers + field placement + POST /api/envelopes).
type UploaderMode = 'preview' | 'compose';

export default function PDFUploader({ breakpoint }: { breakpoint: Breakpoint | null }) {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<UploaderMode>('preview');

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      const url = URL.createObjectURL(file)
      setPdfFile(file);
      setPdfUrl(url);
      console.log(url)
    }
  };

  const compose = mode === 'compose' && pdfUrl && pdfFile;

  return (
    <div className={`mx-auto w-full ${compose ? 'max-w-5xl' : 'max-w-xl'}`}>
      {!pdfUrl && (<>
        <PDFUpload handleUpload={handleUpload} />
        </>
      )}

      {pdfUrl && (<>

        <div className="mt-5 flex gap-2">
          <Button
            variant={mode === 'preview' ? 'default' : 'outline'}
            onClick={() => setMode('preview')}
            data-testid="mode-preview"
          >
            Preview &amp; self-sign
          </Button>
          <Button
            variant={mode === 'compose' ? 'default' : 'outline'}
            onClick={() => setMode('compose')}
            data-testid="mode-compose"
          >
            Send for signature
          </Button>
        </div>

        {mode === 'preview' && (<>
          <div className="mt-5">
            <h3>PDF Preview:</h3>
            <PDFView {...{pdfUrl, breakpoint}} />
          </div>

          {pdfFile && (
            <div className="mt-5">
              <p> <strong>PDF File:</strong> {pdfFile.name}</p>
              <p>{pdfFile.type} | {(pdfFile.size / 1024).toFixed(2)} KB</p>
              <UploadButton handleUpload={handleUpload} text={'Choose Another File'} />
            </div>
          )}
        </>)}

        {compose && (
          // Keyed on the object URL so a newly chosen file resets the draft.
          <EnvelopeComposer key={pdfUrl} pdfFile={pdfFile} pdfUrl={pdfUrl} breakpoint={breakpoint} />
        )}

      </>
      )}
    </div>
  );
};

type UploadButtonProps = {
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  text?: string;
};

function UploadButton(props: UploadButtonProps) {

  const { handleUpload, text } = props;

  return (
    <>
      <input
        type="file"
        accept="application/pdf"
        onChange={handleUpload}
        style={{ display: 'none' }}
        id="file-upload"
      />
        <Button
          onClick={() => document.getElementById('file-upload')?.click()}
        >
        {text || 'Upload PDF'}
        </Button>
    </>)
}

type PDFUploadProps = {
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

function PDFUpload(props: PDFUploadProps) {
  const { handleUpload } = props;

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle>Upload a PDF to Preview</CardTitle>
        <CardDescription>Select a PDF to begin reviewing and signing.</CardDescription>
      </CardHeader>
      <CardContent>
        <UploadButton handleUpload={handleUpload} />
      </CardContent>
    </Card>
  );
}
