import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OtoTap root element is missing");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);