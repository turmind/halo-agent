'use client'

import { useState, useEffect, useCallback } from 'react'
import { WorkspaceLayout } from '@/features/workspace/workspace-layout'
import { useWebSocket } from '@/shared/use-websocket'
import { wsClient } from '@/shared/ws-client'
import { LoginPage } from '@/features/auth/login-page'

export default function HomePage() {
  const { connected } = useWebSocket()
  const [authState, setAuthState] = useState<'checking' | 'login' | 'authenticated'>('checking')

  useEffect(() => {
    fetch('/api/auth/check', { credentials: 'include' })
      .then((res) => {
        setAuthState(res.ok ? 'authenticated' : 'login')
      })
      .catch(() => {
        setAuthState('login')
      })
  }, [])

  // JWT cookie expired mid-session: WsClient detects the rejected WS
  // handshake (verifyClient 401), stops retrying, and emits this event.
  // Swap to the login page instead of reconnecting forever.
  useEffect(() => {
    return wsClient.on('_auth_expired', () => {
      setAuthState('login')
    })
  }, [])

  const handleLoginSuccess = useCallback(() => {
    setAuthState('authenticated')
    // Force WebSocket reconnect with new cookie
    window.location.reload()
  }, [])

  if (authState === 'checking') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--background)]">
        <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>
      </div>
    )
  }

  if (authState === 'login') {
    return <LoginPage onSuccess={handleLoginSuccess} />
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[var(--background)]">
      <WorkspaceLayout connected={connected} />
    </div>
  )
}
