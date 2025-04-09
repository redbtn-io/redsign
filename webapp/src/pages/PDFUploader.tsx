import React, { useState } from 'react';
import '../utils/setupPdf'; // import worker setup

import { PDFView } from '../components/PDFView';
import { Breakpoint } from '../types/breakpoint';

export default function PDFUploader({ breakpoint }: { breakpoint: Breakpoint | null }) {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      const url = URL.createObjectURL(file)
      setPdfFile(file);
      setPdfUrl(url);
      console.log(url)
    }
  };

  return (
    <div>
      {!pdfUrl && (<>
        <PDFUpload handleUpload={handleUpload} />
        </>
      )}

      {pdfUrl && (<>

        <div style={{ marginTop: '20px' }}>
          <h3>PDF Preview:</h3>
          <PDFView {...{pdfUrl, breakpoint}} />
        </div>

        {pdfFile && (
          <div style={{ marginTop: '20px' }}>
            <p> <strong>PDF File:</strong> {pdfFile.name}</p>
            <p>{pdfFile.type} | {(pdfFile.size / 1024).toFixed(2)} KB</p>
            <UploadButton handleUpload={handleUpload} text={'Choose Another File'} />
          </div>
        )}
    
      </>
      )}
    </div>
  );
};

function UploadButton(props: any) {

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
        <button
        onClick={() => document.getElementById('file-upload')?.click()}
        style={{ cursor: 'pointer', padding: '8px 16px', border: 'none', backgroundColor: 'red', color: '#fff', borderRadius: '4px' }}
        >
        {text || 'Upload PDF'}
        </button>
    </>)
}

function PDFUpload(props: any) {
  
  const { handleUpload } = props;

  return (<>
    <h2>Upload a PDF to Preview</h2>
    <UploadButton handleUpload={handleUpload} />
  </>)
}



