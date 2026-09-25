import { Geist, Geist_Mono } from "next/font/google";

// Brief pages only; the rest of Baseline keeps its own type.
export const briefSans = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
export const briefMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
