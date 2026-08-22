import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Web3Provider } from "./context/Web3Context";
import "./styles/globals.css";

const CHUNK_RELOAD_GUARD_KEY = "spoovault-chunk-reload-once";

const shouldRecoverFromChunkError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to fetch dynamically imported module") ||
    normalized.includes("importing a module script failed") ||
    normalized.includes("dynamically imported module")
  );
};

const recoverChunkLoadFailure = () => {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1") {
      return;
    }
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
  } catch {
    // continue and attempt reload even when storage is unavailable
  }

  window.location.reload();
};

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  recoverChunkLoadFailure();
});

window.addEventListener("error", (event) => {
  const message =
    (event.error instanceof Error ? event.error.message : "") ||
    event.message ||
    "";

  if (!message) return;
  if (shouldRecoverFromChunkError(message)) {
    recoverChunkLoadFailure();
  }
});

window.addEventListener("pageshow", () => {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // ignore storage cleanup issues
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Web3Provider>
      <App />
    </Web3Provider>
  </React.StrictMode>
);
