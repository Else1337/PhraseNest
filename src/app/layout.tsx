import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import "@fontsource/noto-serif-sc/400.css";
import "./globals.css";
import "./reading-experience.css";
import "./daily-reading.css";
import "./memory-studio.css";
import "./touch-sidebar.css";
import "./unified-learning.css";
import "./library-studio.css";
import "./student-profile.css";
import "./essay-reader.css";
import "./chat-navigation.css";
import "./teacher-tools.css";
import "./mia-guide.css";

export const metadata: Metadata = {
  title: brand.title,
  applicationName: brand.title,
  description: brand.description
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
