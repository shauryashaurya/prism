import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Prism from "./prism.jsx";

createRoot( document.getElementById( "root" ) ).render(
  <StrictMode>
    <Prism />
  </StrictMode>
);
