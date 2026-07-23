import '../utils/setupPdf'; // import worker setup

import { PDFView } from '../components/PDFView';
import { Breakpoint } from '../types/breakpoint';
import { getPdfUrlFromQuery } from '../utils/pdfUrl';
import {
  getSigningRequestTokenState,
  markSigningRequestTokenUsed,
} from '../utils/signingRequest';

export default function PDFSigner({ breakpoint }: { breakpoint: Breakpoint | null }) {

  const pdfUrl = getPdfUrlFromQuery(window.location.search);
  const signingTokenState = getSigningRequestTokenState(window.location.search);
  const pdfFile: File | null = pdfUrl ? new File([], pdfUrl) : null;

  const completeSigningRequest = () => {
    if (signingTokenState.status === 'valid' && signingTokenState.token) {
      markSigningRequestTokenUsed(signingTokenState.token);
    }
  };

  if (signingTokenState.status === 'missing') {
    if (!pdfUrl) {
      return (
        <div>
          Document Not Found
        </div>
      );
    }
  } else if (signingTokenState.status === 'malformed') {
    return (
      <div role="alert">
        Invalid signing link.
      </div>
    );
  } else if (signingTokenState.status === 'expired') {
    return (
      <div role="alert">
        This signing link has expired.
      </div>
    );
  } else if (signingTokenState.status === 'duplicate') {
    return (
      <div role="alert">
        This signing link has already been used.
      </div>
    );
  }

  const shouldRenderSigner = signingTokenState.status === 'missing' || signingTokenState.status === 'valid';
  if (!shouldRenderSigner) {
    return null;
  }

  if (!pdfUrl) {
    return (
      <div>
        Document Not Found
      </div>
    );
  }

  return (
    <div>
      {pdfUrl && (<>

        <div style={{ marginTop: '20px' }}>
          <h3>PDF Preview:</h3>
          <PDFView {...{pdfUrl, breakpoint}} onSigningComplete={completeSigningRequest} />
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
