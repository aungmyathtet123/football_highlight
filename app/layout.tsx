import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Touchline AI · Football video analysis editor",
    template: "%s · Touchline AI",
  },
  description: "Turn football footage into concise native-frame analysis videos with evidence-led selection, original commentary and tactical graphics.",
  openGraph: {
    title: "Touchline AI",
    description: "Turn football footage into native-frame tactical analysis.",
    images: [{ url: "/og.png", width: 1734, height: 907, alt: "Touchline AI football analysis editor" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Touchline AI",
    description: "Turn football footage into native-frame tactical analysis.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
