import type { Metadata } from "next";
import { Archivo_Black, DM_Mono, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const archivoBlack = Archivo_Black({
  variable: "--font-archivo-black",
  subsets: ["latin"],
  weight: "400",
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Reader Leader",
  description: "A thoughtful reading companion for young readers.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${archivoBlack.variable} ${dmMono.variable} h-full`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
