"use client";
import { Printer } from "lucide-react";
import { Button } from "@/ui/button";

export function PrintButton() {
  return <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer />Print</Button>;
}
