import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'
import ThemeProvider from '@/components/theme-provider'
import { APP_NAME, APP_TAGLINE, APP_LOGO_SRC } from '@/lib/app-brand'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${APP_NAME} - ${APP_TAGLINE}`,
  description: `${APP_NAME} · AI 驱动的终端管理工具`,
  generator: 'v0.app',
  icons: {
    icon: [{ url: APP_LOGO_SRC, type: 'image/jpeg' }],
    apple: APP_LOGO_SRC,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="font-sans antialiased bg-background">
        <ThemeProvider>
          {children}
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
