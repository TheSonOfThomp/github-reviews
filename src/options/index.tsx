import React from "react";
import ReactDOM from "react-dom/client";
import { OptionsPage } from "./options";

const container = document.getElementById("root");

if (!container) {
  throw new Error("No root element found");
}

const root = ReactDOM.createRoot(container);
root.render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>
);
