import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { AppI18nProvider } from '@/shared/i18n'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: 'Halo - Multi-Agent Workspace',
  description: 'Multi-agent collaboration workspace for complex project delivery',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <AppI18nProvider>
          {children}
        </AppI18nProvider>
      </body>
    </html>
  )
}
