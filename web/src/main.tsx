import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installPaseoFetchBridge } from "./paseo-bridge";
import { initializeTaskboardStorage } from "./storage";
import "./styles.css";

async function main() {
  installPaseoFetchBridge();
  await initializeTaskboardStorage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
