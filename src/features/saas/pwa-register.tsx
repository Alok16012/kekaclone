"use client";
import * as React from "react";

/** Registers the service worker once the page is idle. No-op where service workers aren't available. */
export function PwaRegister() {
  React.useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !/[?&]pwa=1/.test(location.search) && localStorage.getItem("erp-pwa") !== "1") return;   // dev: opt in with ?pwa=1
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register(); else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
