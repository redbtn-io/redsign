import React, { useState } from 'react';
import '../utils/setupPdf'; // import worker setup

import { PDFView } from '../components/PDFView';
import { Breakpoint } from '../types/breakpoint';

export default function PDFSigner({ breakpoint }: { breakpoint: Breakpoint | null }) {
    
  
  const query = new URLSearchParams(window.location.search);
  const pdfUrl = query.get('doc') || '/workspaces/redsign/By-Laws.pdf';
  const [pdfFile, setPdfFile] = useState<File | null>(
    pdfUrl ? new File([], pdfUrl) : null
  );


  return (
    <div>
      {!pdfUrl && (<>
        Document Not Found
      </>)}

      {pdfUrl && (<>

        <div style={{ marginTop: '20px' }}>
          <h3>PDF Preview:</h3>
          <PDFView {...{pdfUrl, breakpoint}} />
        </div>

        {pdfFile && (
          <div style={{ marginTop: '20px' }}>
            <p> <strong>PDF File:</strong> {pdfFile.name}</p>
            <p>{pdfFile.type} | {(pdfFile.size / 1024).toFixed(2)} KB</p>
          </div>
        )}
    
      </>
      )}
    </div>
  );
};
