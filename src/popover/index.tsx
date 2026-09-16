import React from "react";
import ReactDOM from "react-dom/client";
import { PopoverContent } from "./popover";

const container = document.getElementById("root");

if (!container) {
  throw new Error("No root element found");
}
// Remove the pre-JS loading skeleton from index.html (explicit rather than
// relying on createRoot's container-clearing behavior)
container.replaceChildren();
const root = ReactDOM.createRoot(container);
root.render(
  <React.StrictMode>
    <PopoverContent />
  </React.StrictMode>
);
