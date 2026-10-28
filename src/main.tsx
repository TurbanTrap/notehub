import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, readTheme } from "./lib/theme";
import { detectOs } from "./lib/platform";

// Before the first render, not in an effect: an effect runs after the browser has
// already painted, which on a dark-theme launch shows a white window for a frame.
applyTheme(readTheme());
document.documentElement.dataset.os = detectOs(navigator.userAgent);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
