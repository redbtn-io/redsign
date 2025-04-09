import React, { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { Button, Modal } from "xiro-ui";
import { SignatureCanvas } from "./SignatureCanvas";
import SignatureDraggable from "./SignatureDraggable";


export function PDFView(props: any) {

    const { pdfUrl, breakpoint } = props;
    const [numPages, setNumPages] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState<number>(1);


    const [adding, setAdding] = useState(false);
    const [modal, setModal] = useState(false);
  
  
    const onLoadSuccess = ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
    };
    const onLoadError = (error: any) => {
      console.error('Error loading PDF: ', error);
    };
    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
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
  
  
    return (
      <div style={{ margin: '0 auto', maxWidth: '100%', width: 'fit-content'}}>
      <Document file={pdfUrl} onLoadSuccess={onLoadSuccess}>
        <ZoomablePDF {...{pdfUrl, onLoadSuccess, currentPage, pdfSize, breakpoint, adding, setAdding, setModal, modal}} />
      </Document>
      <PDFPageButtons {...{ currentPage, setCurrentPage, numPages, adding, setAdding }} />
    </div>
    )
  }

  function ZoomablePDF(props: any) {
    const { pdfUrl, onLoadSuccess, currentPage, pdfSize, breakpoint, adding, setAdding, setModal, modal } = props; 
  
    return (
      <TransformWrapper 
      panning={{ excluded: ['drag-exclude'] }}
      pinch={{ excluded: ['drag-exclude'] }}
      doubleClick={breakpoint == 'sm' ? { excluded: ['drag-exclude'] } : {disabled: true}}
      >
        <TransformComponent>
          <Document file={pdfUrl} onLoadSuccess={onLoadSuccess}>
            <PDFSignature {...{ currentPage, pdfSize, pdfUrl, adding, setAdding, setModal, modal, breakpoint }} />
          </Document>
        </TransformComponent>
      </TransformWrapper>
    );
  }

  function AddSignatures(props: any) {

    const { currentPage, pdfSize, pdfUrl, adding, setAdding, setModal, modal, breakpoint } = props;

    type SignatureField = {
      id: string;
      page: number;
      x: number;
      y: number;
      signed?: string;
    }
    const [fields, setFields] = useState<SignatureField[]>([]);

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

  }

  function PDFSignature(props: any) {

    type SignatureField = {
      id: string;
      page: number;
      x: number;
      y: number;
      signed?: string;
    }

    const { currentPage, pdfSize, pdfUrl, adding, setAdding, setModal, modal, breakpoint } = props;

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
          
            <Modal 
              show={modal}
              onClose={() => setModal(false)}
              styles={{ width: '100%', maxWidth: '600px', margin: '0 auto', pointerEvents: 'auto' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width:'100%' }} className="drag-exclude">
                <SignatureCanvas
                  width={modalWidth()}
                  onCancel={(d)=>d ? setModal(false) : removeSignature()} 
                  onSave={d => {
                    setModal(false)
                    setDefaultValue(d);
                    setFields(prevFields => prevFields.map(field => field.id === modal ? {...field, signed: d} : field))
                  }} 
                  defaultValue={defaultValue} />
              </div>

            </Modal>
        </div>
      </div>
    </>
    )
  }
  
  function PDFPageButtons(props: any) {
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
        onClick={() => setCurrentPage((prev: number) => Math.min(prev + 1, numPages))}
        disabled={currentPage === numPages}
    >
        Next
    </Button>
      </div>)
  }

  function AddSignatureButton(props: any) {
    const { adding, setAdding, } = props;
    return (
      <Button
        styles={{ pointerEvents: 'auto' }}
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