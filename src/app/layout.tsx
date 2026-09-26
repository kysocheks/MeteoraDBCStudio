import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Meteora DBC Studio", description: "Institutional DBC configuration and simulation workbench", icons: { icon: "/icon.svg", shortcut: "/icon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
