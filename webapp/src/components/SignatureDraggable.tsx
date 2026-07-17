import { CSSProperties, useRef } from 'react';
import { Rnd } from 'react-rnd';
import { shouldOpenSignatureModal } from '../utils/signatureDrag';

type Props = {
    x: number;
    y: number;
    setModal: any;
    signed?: string;
    id?: string;
    width?: number;
    height?: number;
    onUpdate: (pos: { x: number; y: number; width: number; height: number }) => void;
  };

export default function SignatureDraggable({ x, y, width = 120, height = 40, onUpdate, id, setModal, signed }: Props) {

    const dragStartPos = useRef<{ x: number; y: number } | null>(null);

    const style: CSSProperties = signed ? {
      pointerEvents: 'auto',
      border: '2px dashed var(--primary-color)',
    }
    : {
      border: '2px dashed var(--primary-color)',
      backgroundColor: 'rgba(0, 150, 255, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 'bold',
      cursor: 'move',
      pointerEvents: 'auto',
      touchAction: 'none',
    }

  return (
    <Rnd
      default={{
        x,
        y,
        width,
        height,
      }}
      bounds="parent"
      onDragStart={(e:any, data) => {
        e.stopPropagation();
        dragStartPos.current = { x: data.x, y: data.y };
      }}
      onDragStop={(_, d) => {
        const pos = { x: d.x, y: d.y };
        onUpdate({ x: d.x, y: d.y, width, height })
        const start = dragStartPos.current ?? pos;
        if (shouldOpenSignatureModal(start, pos) && id) {
          setModal(id);
        }
        dragStartPos.current = null;
      }}
      onResizeStop={(_, __, ref, ___, pos) => {
        onUpdate({
          x: pos.x,
          y: pos.y,
          width: parseFloat(ref.style.width),
          height: parseFloat(ref.style.height),
        });
      }}
      onPointerDown={(e: any) => {
        e.stopPropagation();
      }}

      style={style}

      className='drag-exclude'
    >
      {signed ? <>
        <img
          src={signed}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
          }}
        />
      </>: 'Signature'}
    </Rnd>
  );
};
