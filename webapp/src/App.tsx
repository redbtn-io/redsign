import { AppShell } from '@redbtn/redstyle';
import PDFUploader from './pages/PDFUploader';
import { useEffect, useState } from "react";
import { Breakpoint } from "./types/breakpoint";
import { Route, Routes } from "react-router";
import PDFSigner from "./pages/PDFSigner";

export default function App () {


    const [breakpoint, setBreakpoint] = useState<Breakpoint|null>(null);
  
    useEffect(() => {
      const handleResize = () => {
        const width = window.innerWidth;
        if (width < 640) setBreakpoint("sm");
        else if (width < 768) setBreakpoint("md");
        else if (width < 1024) setBreakpoint("lg");
        else if (width < 1280) setBreakpoint("xl");
        else setBreakpoint("2xl");
      };
      handleResize(); // Set initial breakpoint
      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    },[]);





  return (
    <AppShell>
      <AppShell.Header sticky={false} className="border-b border-border bg-bg-elevated px-4 py-3 shadow-sm">
        <span className="text-base font-semibold text-text-primary">Redsign</span>
      </AppShell.Header>
      <AppShell.Content scroll={false} className="p-4">
        <Routes>
          <Route path="/" element={<PDFUploader {...{breakpoint}}/>} />
          <Route path='/sign' element={<PDFSigner {...{breakpoint}}/>} />
        </Routes>
      </AppShell.Content>
    </AppShell>

  );
};
