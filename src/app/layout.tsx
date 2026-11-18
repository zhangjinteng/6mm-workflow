import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZJT Workflow",
  description: "ZJT Workflow 应用开发框架",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
