import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const FREE_LOGGED_IN_LIMIT = 10
const GUEST_LIMIT = 3
const API_BASE_URL = 'https://scriptforge-production.up.railway.app'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null

const INITIAL_GENERATION_STATE = {
  count: 0,
  limit: FREE_LOGGED_IN_LIMIT,
  isPaid: false,
}

function getMonthKey(date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`
}

function parseScript(script) {
  const capture = (label, nextLabel) => {
    const regex = new RegExp(
      `${label}:\\s*([\\s\\S]*?)(?=${nextLabel ? `${nextLabel}:` : '$'})`,
      'm',
    )
    return script.match(regex)?.[1]?.trim() ?? ''
  }

  return {
    hook: capture('🔥 HOOK', '📈 ESCALATION'),
    escalation: capture('📈 ESCALATION', '🎭 TWIST'),
    twist: capture('🎭 TWIST', '💬 ENGAGEMENT BAIT'),
    engagement: capture('💬 ENGAGEMENT BAIT', ''),
  }
}

function App() {
  const [session, setSession] = useState(null)
  const [story, setStory] = useState('')
  const [script, setScript] = useState('')
  const [error, setError] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [needsUsernameSetup, setNeedsUsernameSetup] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [generationState, setGenerationState] = useState(INITIAL_GENERATION_STATE)
  const [guestRemaining, setGuestRemaining] = useState(GUEST_LIMIT)
  const [showPaywall, setShowPaywall] = useState(false)
  const [bannerMessage, setBannerMessage] = useState('')

  const scriptSections = useMemo(() => parseScript(script), [script])

  const user = session?.user ?? null
  const canUseSupabase = Boolean(supabase)

  useEffect(() => {
    if (!canUseSupabase) {
      setError('Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to use auth.')
      return undefined
    }

    const checkoutStatus = new URLSearchParams(window.location.search).get(
      'checkout',
    )
    if (checkoutStatus === 'success') {
      setBannerMessage('Payment succeeded. Your Pro access is being activated.')
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (checkoutStatus === 'cancelled') {
      setBannerMessage('Checkout cancelled. You can upgrade anytime.')
      window.history.replaceState({}, '', window.location.pathname)
    }

    const loadSession = async () => {
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) {
        setError(sessionError.message)
        return
      }
      setSession(data.session)
    }

    void loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setScript('')
      setError('')
      setShowPaywall(false)
    })

    return () => subscription.unsubscribe()
  }, [canUseSupabase])

  useEffect(() => {
    if (!user || !canUseSupabase) {
      setNeedsUsernameSetup(false)
      setGenerationState(INITIAL_GENERATION_STATE)
      return
    }

    const hydrateUserState = async () => {
      const nowMonthKey = getMonthKey(new Date())

      const [{ data: profileData }, { data: countData }, { data: subData }] =
        await Promise.all([
          supabase.from('profiles').select('username, display_name').eq('id', user.id).maybeSingle(),
          supabase
            .from('user_counts')
            .select('count, last_reset')
            .eq('user_id', user.id)
            .maybeSingle(),
          supabase
            .from('user_subscriptions')
            .select('status')
            .eq('user_id', user.id)
            .maybeSingle(),
        ])

      if (!profileData?.username) {
        setNeedsUsernameSetup(true)
      } else {
        setNeedsUsernameSetup(false)
        setUsername(profileData.username)
        setDisplayName(profileData.display_name ?? '')
      }

      const isPaid = subData?.status === 'active'
      const rowMonthKey = countData?.last_reset
        ? getMonthKey(new Date(countData.last_reset))
        : nowMonthKey
      const safeCount = rowMonthKey === nowMonthKey ? countData?.count ?? 0 : 0

      setGenerationState({
        count: safeCount,
        limit: FREE_LOGGED_IN_LIMIT,
        isPaid,
      })
    }

    void hydrateUserState()
  }, [canUseSupabase, user])

  const signInWithGoogle = async () => {
    if (!canUseSupabase) return
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    })
    if (signInError) setError(signInError.message)
  }

  const signOut = async () => {
    if (!canUseSupabase) return
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) setError(signOutError.message)
    setUsername('')
    setDisplayName('')
    setStory('')
  }

  const saveUsername = async (event) => {
    event.preventDefault()
    if (!canUseSupabase || !user) return
    if (!username.trim()) {
      setError('Username is required.')
      return
    }

    setIsSavingProfile(true)
    setError('')

    const profilePayload = {
      id: user.id,
      username: username.trim().toLowerCase(),
      display_name: displayName.trim() || username.trim(),
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'id' })

    if (profileError) {
      setError(profileError.message)
      setIsSavingProfile(false)
      return
    }

    await supabase
      .from('user_counts')
      .upsert({ user_id: user.id, count: 0 }, { onConflict: 'user_id' })

    setNeedsUsernameSetup(false)
    setIsSavingProfile(false)
  }

  const generateScript = async () => {
    if (!story.trim()) {
      setError('Paste a Reddit story before generating.')
      return
    }

    setIsGenerating(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story,
          userId: user?.id ?? null,
          isPaid: generationState.isPaid,
        }),
      })

      const payload = await response.json()
      if (!response.ok) {
        if (response.status === 402) {
          setShowPaywall(true)
        }
        setError(payload.error ?? 'Script generation failed.')
        return
      }

      setScript(payload.script ?? '')

      if (user) {
        setGenerationState((prev) => ({
          ...prev,
          count: typeof payload.count === 'number' ? payload.count : prev.count,
          limit:
            typeof payload.limit === 'number'
              ? payload.limit
              : FREE_LOGGED_IN_LIMIT,
          isPaid:
            typeof payload.isPaid === 'boolean'
              ? payload.isPaid
              : prev.isPaid,
        }))
      } else if (typeof payload.remainingGuestGenerations === 'number') {
        setGuestRemaining(payload.remainingGuestGenerations)
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsGenerating(false)
    }
  }

  const copyScript = async () => {
    if (!script) return
    try {
      await navigator.clipboard.writeText(script)
      setBannerMessage('Script copied to clipboard.')
      setTimeout(() => setBannerMessage(''), 2000)
    } catch (_clipboardError) {
      setError('Clipboard permission denied. Copy manually.')
    }
  }

  const startCheckout = async () => {
    if (!user) {
      setError('Sign in first to upgrade.')
      return
    }
    setIsCheckoutLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_BASE_URL}/api/create-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          userEmail: user.email,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        setError(payload.error ?? 'Unable to start checkout.')
        return
      }
      window.location.href = payload.url
    } catch (checkoutError) {
      setError(checkoutError.message)
    } finally {
      setIsCheckoutLoading(false)
    }
  }

  return (
    <div className="app">
      <style>{`
        :root {
          font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          color: #f5f3ff;
          background-color: #09090f;
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          background: radial-gradient(circle at top, #1f103f, #09090f 40%);
          min-height: 100vh;
        }
        .app {
          max-width: 1040px;
          margin: 0 auto;
          padding: 24px 16px 56px;
        }
        .panel {
          background: rgba(17, 24, 39, 0.82);
          border: 1px solid #312e81;
          border-radius: 16px;
          box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.2), 0 20px 60px rgba(2, 6, 23, 0.5);
          backdrop-filter: blur(4px);
        }
        .header {
          padding: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .brand h1 {
          margin: 0;
          font-size: 1.35rem;
          letter-spacing: 0.02em;
        }
        .brand p {
          margin: 4px 0 0;
          color: #c4b5fd;
          font-size: 0.92rem;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          background: rgba(168, 85, 247, 0.12);
          color: #e9d5ff;
          border: 1px solid rgba(168, 85, 247, 0.5);
          padding: 6px 12px;
          font-size: 0.78rem;
        }
        .stack {
          display: grid;
          grid-template-columns: 1fr;
          gap: 16px;
          margin-top: 16px;
        }
        .workspace {
          padding: 18px;
        }
        .workspace h2 {
          margin: 0 0 12px;
          font-size: 1.1rem;
        }
        textarea {
          width: 100%;
          min-height: 220px;
          border-radius: 14px;
          border: 1px solid #4338ca;
          background: #0f172a;
          color: #f8fafc;
          resize: vertical;
          padding: 14px;
          font-size: 1rem;
          line-height: 1.5;
        }
        textarea:focus,
        input:focus {
          outline: 2px solid #a855f7;
          outline-offset: 1px;
        }
        .controls {
          margin-top: 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }
        .actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        button {
          border: none;
          border-radius: 10px;
          padding: 10px 14px;
          cursor: pointer;
          font-weight: 600;
          transition: transform 0.15s ease, opacity 0.15s ease;
        }
        button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        button:hover:not(:disabled) {
          transform: translateY(-1px);
        }
        .primary {
          background: #a855f7;
          color: #fff;
        }
        .ghost {
          background: transparent;
          color: #e9d5ff;
          border: 1px solid #7c3aed;
        }
        .muted {
          font-size: 0.85rem;
          color: #cbd5e1;
        }
        .sections {
          display: grid;
          gap: 12px;
          margin-top: 14px;
        }
        .section {
          border: 1px solid #4c1d95;
          border-radius: 12px;
          background: #0b1222;
          padding: 12px;
        }
        .section h3 {
          margin: 0 0 8px;
          font-size: 0.94rem;
          color: #e9d5ff;
        }
        .section p {
          margin: 0;
          white-space: pre-wrap;
          color: #f8fafc;
          line-height: 1.5;
        }
        .form-grid {
          display: grid;
          gap: 10px;
        }
        input {
          border-radius: 10px;
          border: 1px solid #4338ca;
          background: #0f172a;
          color: #f8fafc;
          padding: 10px 12px;
          width: 100%;
          font-size: 0.95rem;
        }
        .message {
          margin-top: 10px;
          border-radius: 10px;
          padding: 10px 12px;
          font-size: 0.9rem;
        }
        .message.error {
          background: rgba(220, 38, 38, 0.2);
          border: 1px solid rgba(252, 165, 165, 0.5);
          color: #fee2e2;
        }
        .message.info {
          background: rgba(168, 85, 247, 0.18);
          border: 1px solid rgba(216, 180, 254, 0.5);
          color: #f5d0fe;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(2, 6, 23, 0.72);
          display: grid;
          place-items: center;
          padding: 16px;
          z-index: 20;
        }
        .modal {
          width: min(430px, 100%);
          border-radius: 16px;
          background: #111827;
          border: 1px solid #6d28d9;
          padding: 18px;
        }
        .modal h3 {
          margin: 0;
          color: #faf5ff;
        }
        .modal p {
          color: #d8b4fe;
          line-height: 1.5;
        }
        .modal ul {
          color: #f3e8ff;
          line-height: 1.6;
          padding-left: 18px;
        }
        @media (max-width: 640px) {
          .app {
            padding: 14px 12px 36px;
          }
          .header,
          .workspace {
            padding: 14px;
          }
          textarea {
            min-height: 180px;
          }
        }
      `}</style>

      <header className="panel header">
        <div className="brand">
          <h1>ScriptForge</h1>
          <p>Turn Reddit drama into viral TikTok scripts.</p>
        </div>
        <div className="actions">
          {user ? (
            <>
              <span className="badge">
                {generationState.isPaid
                  ? 'Pro plan: Unlimited'
                  : `${generationState.count}/${generationState.limit} this month`}
              </span>
              <button className="ghost" type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <button className="primary" type="button" onClick={signInWithGoogle}>
              Continue with Google
            </button>
          )}
        </div>
      </header>

      {(error || bannerMessage) && (
        <div className={`message ${error ? 'error' : 'info'}`}>
          {error || bannerMessage}
        </div>
      )}

      <section className="stack">
        {user && needsUsernameSetup ? (
          <div className="panel workspace">
            <h2>Choose your profile details</h2>
            <p className="muted">
              First login setup. This writes to the <code>profiles</code> table.
            </p>
            <form className="form-grid" onSubmit={saveUsername}>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username (unique)"
                maxLength={25}
                required
              />
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Display name (optional)"
                maxLength={40}
              />
              <button className="primary" type="submit" disabled={isSavingProfile}>
                {isSavingProfile ? 'Saving profile...' : 'Save profile'}
              </button>
            </form>
          </div>
        ) : (
          <div className="panel workspace">
            <h2>Paste your Reddit story</h2>
            <textarea
              value={story}
              onChange={(event) => setStory(event.target.value)}
              placeholder="Drop the full Reddit story, including context, timeline, and conflict..."
            />
            <div className="controls">
              <span className="muted">
                {user
                  ? generationState.isPaid
                    ? 'Unlimited generations enabled.'
                    : `${generationState.limit - generationState.count} free generations left this month.`
                  : `${guestRemaining} of ${GUEST_LIMIT} free guest generations left.`}
              </span>
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={generateScript}
                  disabled={isGenerating}
                >
                  {isGenerating ? 'Generating...' : 'Generate Script'}
                </button>
                {script && (
                  <button className="ghost" type="button" onClick={copyScript}>
                    Copy to clipboard
                  </button>
                )}
              </div>
            </div>

            {script && (
              <div className="sections">
                <div className="section">
                  <h3>🔥 HOOK</h3>
                  <p>{scriptSections.hook || 'Not detected'}</p>
                </div>
                <div className="section">
                  <h3>📈 ESCALATION</h3>
                  <p>{scriptSections.escalation || 'Not detected'}</p>
                </div>
                <div className="section">
                  <h3>🎭 TWIST</h3>
                  <p>{scriptSections.twist || 'Not detected'}</p>
                </div>
                <div className="section">
                  <h3>💬 ENGAGEMENT BAIT</h3>
                  <p>{scriptSections.engagement || 'Not detected'}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {showPaywall && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Free limit reached</h3>
            <p>Upgrade to ScriptForge Pro for unlimited generations and faster workflow.</p>
            <ul>
              <li>$12/month recurring plan</li>
              <li>Unlimited script generations</li>
              <li>Priority quality optimization updates</li>
            </ul>
            <div className="actions">
              <button className="primary" type="button" onClick={startCheckout} disabled={isCheckoutLoading}>
                {isCheckoutLoading ? 'Opening checkout...' : 'Upgrade to Pro'}
              </button>
              <button className="ghost" type="button" onClick={() => setShowPaywall(false)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
