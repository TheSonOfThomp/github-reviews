import React from "react";
import ReactDOM from "react-dom/client";
import { PopoverContent } from "./popover";

const container = document.getElementById("root");

if (!container) {
  throw new Error("No root element found");
}
// Remove the pre-JS loading skeleton from index.html: both the markup and
// its stylesheet — the skeleton <style> targets #root, so if it survived the
// mount its padding/flex rules would inset and squeeze the React tree
container.replaceChildren();
document.getElementById("skeleton-style")?.remove();
const root = ReactDOM.createRoot(container);
root.render(
  <React.StrictMode>
    <PopoverContent />
  </React.StrictMode>
);
