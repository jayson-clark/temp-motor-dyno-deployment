import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Controller } from "./state/controller";
import { ControllerContext } from "./state/hooks";
import "./styles.css";

const controller = new Controller();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ControllerContext value={controller}>
      <App />
    </ControllerContext>
  </StrictMode>,
);
