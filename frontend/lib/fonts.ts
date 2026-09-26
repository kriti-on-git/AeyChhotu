import { Fraunces, Inter } from "next/font/google";

export const displayFont = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

export const sansFont = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
