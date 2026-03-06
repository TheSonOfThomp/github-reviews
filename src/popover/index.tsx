import React from "react";
import ReactDOM from "react-dom/client";
import { PopoverContent } from "./popover";

const container = document.getElementById("root");

if (!container) {
  throw new Error("No root element found");
}
const root = ReactDOM.createRoot(container);
root.render(
  <React.StrictMode>
    <PopoverContent />
  </React.StrictMode>
);
