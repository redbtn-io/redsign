import React, { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { Button, Dialog, DialogContent } from "@redbtn/redstyle";
import { SignatureCanvas } from "./SignatureCanvas";
import SignatureDraggable from "./SignatureDraggable";
import { Breakpoint } from "../types/breakpoint";

type PDFViewProps = {
  pdfUrl: string;
  breakpoint: Breakpoint | null;
  onSigningComplete?: () => void;
};

export function PDFView(props: PDFViewProps) {

    const { pdfUrl, breakpoint, onSigningComplete } = props;
    const [numPages, setNumPages] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState<number>(1);
    const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);


    const [adding, setAdding] = useState(false);
    const [modal, setModal] = useState<boolean | string>(false);
  
  
    const onLoadSuccess = ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
    };
    const onLoadError = (error: Error) => {
      console.error('Error loading PDF: ', error);
      const message = (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
        ? error.message
        : 'Unable to load this PDF document.';
      setLoadErrorMessage(message);
    };

      function pdfSize() {
        switch (breakpoint) {
          case "sm":
            return window.innerWidth < 640 ? window.innerWidth - 20 : 300;
          case "md":
            return window.innerWidth < 640 ? window.innerWidth - 20 : 400;
          case "lg":
            return 500;
          case "xl":
            return 600;
          case "2xl":
            return 700;
          default:
            return 600;
        }
      }

      if (loadErrorMessage) {
        return (
          <div role="alert" style={{ margin: '40px auto', textAlign: 'center', maxWidth: '600px' }}>
            <p>Unable to load the PDF document.</p>
            <p>{loadErrorMessage}</p>
          </div>
        )
      }
  
  
    return (
      <div style={{ margin: '0 auto', maxWidth: '100%', width: 'fit-content'}}>
      <Document file={pdfUrl} onLoadSuccess={onLoadSuccess} onLoadError={onLoadError}>
        <ZoomablePDF {...{pdfUrl, onLoadSuccess, onLoadError, currentPage, pdfSize, breakpoint, adding, setAdding, setModal, modal, onSigningComplete}} />
      </Document>
      <PDFPageButtons {...{ currentPage, setCurrentPage, numPages, adding, setAdding }} />
    </div>
    )
  }

  type ZoomablePDFProps = {
    pdfUrl: string;
    onLoadSuccess: (document: { numPages: number }) => void;
    onLoadError: (error: Error) => void;
    currentPage: number;
    pdfSize: () => number;
    breakpoint: Breakpoint | null;
    adding: boolean;
    setAdding: React.Dispatch<React.SetStateAction<boolean>>;
    setModal: React.Dispatch<React.SetStateAction<boolean | string>>;
    modal: boolean | string;
    onSigningComplete?: () => void;
  };

  function ZoomablePDF(props: ZoomablePDFProps) {
    const { pdfUrl, onLoadSuccess, onLoadError, currentPage, pdfSize, breakpoint, adding, setAdding, setModal, modal, onSigningComplete } = props;
  
    return (
      <TransformWrapper 
      panning={{ excluded: ['drag-exclude'] }}
      pinch={{ excluded: ['drag-exclude'] }}
      doubleClick={breakpoint == 'sm' ? { excluded: ['drag-exclude'] } : {disabled: true}}
      >
        <TransformComponent>
          <Document file={pdfUrl} onLoadSuccess={onLoadSuccess} onLoadError={onLoadError}>
            <PDFSignature {...{ currentPage, pdfSize, pdfUrl, adding, setAdding, setModal, modal, breakpoint, onSigningComplete }} />
          </Document>
        </TransformComponent>
      </TransformWrapper>
    );
  }
  type PDFSignatureProps = {
    currentPage: number;
    pdfSize: () => number;
    pdfUrl: string;
    adding: boolean;
    setAdding: React.Dispatch<React.SetStateAction<boolean>>;
    setModal: React.Dispatch<React.SetStateAction<boolean | string>>;
    modal: boolean | string;
    breakpoint: Breakpoint | null;
    onSigningComplete?: () => void;
  };

  function PDFSignature(props: PDFSignatureProps) {

    type SignatureField = {
      id: string;
      page: number;
      x: number;
      y: number;
      signed?: string;
    }

    const { currentPage, pdfSize, pdfUrl, adding, setAdding, setModal, modal, breakpoint, onSigningComplete } = props;

    const [fields, setFields] = useState<SignatureField[]>([]);
    const [defaultValue, setDefaultValue] = useState<string | undefined>();

    const containerRef = useRef<HTMLDivElement | null>(null);

    const handlePageClick = (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (container && adding) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setFields((prevFields) => [
          ...prevFields,
          { id: crypto.randomUUID(), page:currentPage, x, y },
        ]);
        setAdding(false);
      }
    }

    const updateFieldPosition = (id: string, x: number, y: number) => {
      setFields((prevFields) =>
        prevFields.map((field) =>
          field.id === id ? { ...field, x, y } : field
        )
      );
    }

    useEffect(()=>{
      setFields([])
    }, [pdfUrl])

    function removeSignature() {
      setFields((prevFields) => prevFields.filter((field) => field.id !== modal));
      setModal(false);
    }

    function modalWidth() {
      switch (breakpoint) {
        case "sm":
          return window.innerWidth < 640 ? window.innerWidth - 30 : 280;
        case "md":
          return window.innerWidth < 640 ? window.innerWidth - 30 : 380;
        case "lg":
          return 480;
        case "xl":
          return 580;
        case "2xl":
          return 600;
        default:
          return 600;
      }
    }

    return (<>
      <div onClick={handlePageClick} ref={containerRef}>
        <Page
        pageNumber={currentPage}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        width={pdfSize()}
        />
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}>
          {fields.filter( f => f.page === currentPage).map((field) => (
            <SignatureDraggable
              key={field.id}
              id={field.id}
              x={field.x}
              y={field.y}
              onUpdate={(pos) => updateFieldPosition(field.id, pos.x, pos.y)}
              width={120}
              height={40}
              setModal={setModal}
              signed={field.signed}
            />
          ))}
          
            <Dialog open={Boolean(modal)} onOpenChange={(open) => setModal(open)}>
              <DialogContent
                className="p-0"
              >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: `${modalWidth()}px`,
                  maxWidth: '100%',
                  pointerEvents: 'auto',
                }}
                className="drag-exclude"
              >
                <SignatureCanvas
                  width={modalWidth()}
                  onCancel={(d)=>d ? setModal(false) : removeSignature()} 
                  onSave={d => {
                    setModal(false)
                    setDefaultValue(d);
                    setFields(prevFields => prevFields.map(field => field.id === modal ? {...field, signed: d} : field))
                    onSigningComplete?.();
                  }} 
                  defaultValue={defaultValue} />
              </div>
              </DialogContent>
            </Dialog>
        </div>
      </div>
    </>
    )
  }
  
  type PDFPageButtonsProps = {
    currentPage: number;
    setCurrentPage: React.Dispatch<React.SetStateAction<number>>;
    numPages: number | null;
    adding: boolean;
    setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  };

  function PDFPageButtons(props: PDFPageButtonsProps) {
    const { currentPage, setCurrentPage, numPages, adding, setAdding, } = props;
  
    return (
      <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        margin: '5px 0 0 0'
      }}
      >
      <Button 
      onClick={() => setCurrentPage((prev: number) => Math.max(prev - 1, 1))}
      disabled={currentPage === 1}
      >
        Previous
      </Button>
      <AddSignatureButton {...{ adding, setAdding }} />
      <Button 
        onClick={() => setCurrentPage((prev: number) => Math.min(prev + 1, numPages ?? prev + 1))}
        disabled={currentPage === numPages}
    >
        Next
    </Button>
      </div>)
  }

  type AddSignatureButtonProps = {
    adding: boolean;
    setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  };

  function AddSignatureButton(props: AddSignatureButtonProps) {
    const { adding, setAdding, } = props;
    return (
      <Button
        onClick={() => {
          if (!adding) {
            setAdding(true);
          } else if (adding) {
            setAdding(false);
          }
        }}
      >
        {(adding) ? 'Cancel' : 'Add Signature'}
      </Button>
    );
  }
