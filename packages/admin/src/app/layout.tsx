import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { AppI18nProvider } from '@/shared/i18n'
import { ThemeProvider } from '@/shared/theme'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

export const metadata: Metadata = {
  title: 'Halo - Multi-Agent Workspace',
  description: 'Multi-agent collaboration workspace for complex project delivery',
}

// Anti-flash: stamp data-theme from the localStorage cache before first paint.
// This is a static export (no SSR cookies), so a React effect would run after
// hydration and light-theme users would see a dark flash on every load. Keep
// in sync with THEMES / UI_STYLES in shared/theme/context.tsx; dark stays
// attribute-less since it's the :root default. The UI style defaults to
// modern (no / unknown cache → modern); only an explicit classic leaves
// data-ui-style off, which is what classic renders as.
const themeInitScript = `try{var d=document.documentElement.dataset,t=localStorage.getItem('halo_theme'),s=localStorage.getItem('halo_ui_style');if(t==='light'||t==='midnight'||t==='warm')d.theme=t;if(s!=='classic')d.uiStyle=s==='soft'?'soft':'modern'}catch(e){}`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <AppI18nProvider>
            {children}
          </AppI18nProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
