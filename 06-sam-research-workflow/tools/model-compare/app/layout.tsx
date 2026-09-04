import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SAM Compare｜多模型試算表差異分析",
  description:
    "在本機稽核 SAM dataset Skill 規格，並按來源與 ref 比較任意數量的 XLSX／CSV 模型輸出。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>
        {children}
      </body>
    </html>
  );
}
