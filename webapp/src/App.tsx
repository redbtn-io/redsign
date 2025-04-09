import { Main, Nav } from "xiro-ui";
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





  return (<>
    
    <Nav fixed styles={{ padding: '0 10px', boxShadow: '0px 4px 6px rgba(0, 0, 0, 0.1)' }}>
        Redsign
    </Nav>
      <Main styles={{ bottom: '0', padding: '10px' }}>
        <Routes>
          <Route path="/" element={<PDFUploader {...{breakpoint}}/>} />
          <Route path='/sign' element={<PDFSigner {...{breakpoint}}/>} />
        </Routes>
      </Main>
  </>

  );
};