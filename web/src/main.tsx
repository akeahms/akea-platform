import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Refuse to run inside another site's frame (stops click-jacking). The Render "X-Frame-Options: DENY" header does the same at the server.
if (window.top !== window.self) {
  document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">This portal can only be opened directly. <a href="' + location.href + '" target="_top">Open it here</a>.</p>';
} else {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
