import { useRef, useState, useEffect } from 'react';
import { Button } from 'xiro-ui';

type SignatureCanvasProps = {
  width?: number;
  height?: number;
  defaultValue?: string;
  onSave: (dataUrl: string) => void;
  onCancel: (hasDrawn: boolean) => void;
};

export const SignatureCanvas = ({
  width = 400,
  height = 125,
  onSave,
  onCancel,
  defaultValue,
}: SignatureCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  const getContext = () => canvasRef.current?.getContext('2d');

  useEffect(() => {
    const ctx = getContext();
    if (!ctx || !canvasRef.current) return;

      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

    if (defaultValue) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        setHasDrawn(true);
      }
      img.src = defaultValue;
    }

  }, [defaultValue]);

  const getCanvasOffset = (e: MouseEvent | TouchEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };

    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (defaultValue) clear();
    const { x, y } = getCanvasOffset(e.nativeEvent);
    const ctx = getContext();
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      setDrawing(true);
    }
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing) return;
    const { x, y } = getCanvasOffset(e.nativeEvent);
    const ctx = getContext();
    if (ctx) {
      ctx.lineTo(x, y);
      ctx.stroke();
      setHasDrawn(true);
    }
  };

  const stopDrawing = () => {
    setDrawing(false);
  };

  const clear = () => {
    const ctx = getContext();
    if (ctx) {
      ctx.clearRect(0, 0, width, height);
      setHasDrawn(false);
    }
  };

  const save = () => {
    if (!hasDrawn || !canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onSave(dataUrl);
  };

  const cancel = () => {
    onCancel(hasDrawn)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ border: '1px solid #ccc', touchAction: 'none' }}
        onMouseDown={startDrawing}
        onTouchStart={startDrawing}
        onMouseMove={draw}
        onTouchMove={draw}
        onMouseUp={stopDrawing}
        onTouchEnd={stopDrawing}
        onMouseLeave={stopDrawing}
      />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button onClick={clear}>Clear</Button>
        <Button onClick={cancel}>{hasDrawn ? 'Cancel' : 'Remove'}</Button>
        <Button onClick={save} disabled={!hasDrawn}>
          Save
        </Button>
      </div>
    </div>
  );
};
