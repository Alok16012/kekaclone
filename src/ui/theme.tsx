"use client";
import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { Menu } from "./overlay";
import { IconButton } from "./button";

type Mode = "light" | "dark" | "system";
const KEY = "erp-theme";

/** Inline in <head>: sets data-theme before paint so there is no flash. */
export const themeScript = `(function(){try{var m=localStorage.getItem('${KEY}');if(m==='light'||m==='dark')document.documentElement.dataset.theme=m;else if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark';}catch(e){}})()`;

function apply(mode: Mode) {
  try { if (mode === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch {}
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeToggle() {
  return (
    <Menu trigger={<IconButton label="Theme"><Sun className="dark:hidden" /><Moon className="hidden dark:block" /></IconButton>}
      items={[
        { label: "Light", icon: <Sun />, onSelect: () => apply("light") },
        { label: "Dark", icon: <Moon />, onSelect: () => apply("dark") },
        { label: "System", icon: <Monitor />, onSelect: () => apply("system") },
      ]} />
  );
}
