import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  accountResponse,
  sessionResponse,
  request,
  ApiFailure,
  failureMessage,
  type Account,
  type DeviceSession,
} from './api.js';

const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const localDemo = import.meta.env.DEV && import.meta.env.VITE_LOCAL_DEMO === 'true';
const mailbox = (() => {
  if (!localDemo) return undefined;
  try {
    const url = new URL(import.meta.env.VITE_MAILBOX_ORIGIN ?? '');
    return url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
})();
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 3 20 6v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </svg>
    </span>
  );
}
function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={'notice' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
function MailboxLink() {
  return mailbox ? (
    <a className="button secondary" href={mailbox} target="_blank" rel="noreferrer">
      Open local test mailbox ↗
    </a>
  ) : null;
}
export function App({ verificationToken }: { verificationToken: string | undefined }) {
  const path = window.location.pathname;
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState('');
  useEffect(() => {
    let active = true;
    void request('me')
      .then(accountResponse)
      .then((value) => {
        if (active) setAccount(value);
      })
      .catch((error) => {
        if (active && !(error instanceof ApiFailure && error.status === 401))
          setLoadFailure(failureMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const privatePage = ['/dashboard', '/profile', '/security'].includes(path);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <a className="brand" href="/">
          <Mark />
          <span>AuthCore</span>
        </a>
        <nav aria-label="Main navigation">
          {localDemo && <span className="demo-tag">LOCAL DEMO</span>}
          {account ? (
            <>
              <a href="/dashboard" aria-current={path === '/dashboard' ? 'page' : undefined}>
                Workspace
              </a>
              <a href="/security" aria-current={path === '/security' ? 'page' : undefined}>
                Security
              </a>
              <a className="account-link" href="/profile" aria-label="Account profile">
                {account.email.slice(0, 1).toUpperCase()}
              </a>
            </>
          ) : (
            <>
              <a href="/login">Sign in</a>
              <a className="button small" href="/register">
                Create account
              </a>
            </>
          )}
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {privatePage ? (
          loading ? (
            <div className="page">
              <Notice>Checking your session…</Notice>
            </div>
          ) : loadFailure ? (
            <div className="page">
              <Notice error>{loadFailure}</Notice>
              <button onClick={() => window.location.reload()}>Try again</button>
            </div>
          ) : account ? (
            <Workspace
              account={account}
              page={path}
              onLogout={() => {
                setAccount(null);
                window.location.assign('/login');
              }}
            />
          ) : (
            <div className="auth-layout">
              <section className="auth-card">
                <p className="eyebrow">ACCOUNT ACCESS</p>
                <h1>Sign in to continue</h1>
                <p>Your session is missing, expired or revoked.</p>
                <a className="button" href="/login">
                  Sign in
                </a>
              </section>
            </div>
          )
        ) : path === '/login' || path === '/register' ? (
          <CredentialForm register={path === '/register'} />
        ) : path === '/verify' ? (
          <Verification token={verificationToken} />
        ) : path === '/' ? (
          <Landing signedIn={!!account} />
        ) : (
          <div className="page">
            <p className="eyebrow">404</p>
            <h1>Page not found</h1>
            <p>This address is unavailable.</p>
            <a className="button" href="/">
              Return home
            </a>
          </div>
        )}
      </main>
      <footer>
        <span>
          AuthCore <span className="footer-dot">•</span> Identity &amp; access workspace
        </span>
        <span>Development candidate · Independent review pending</span>
      </footer>
    </>
  );
}
function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="landing">
      <section className="hero">
        <p className="eyebrow">YOUR ACCOUNT. YOUR CONTROL.</p>
        <h1>
          A clear view of
          <br />
          your account security.
        </h1>
        <p className="lead">
          Create your account, verify your email and manage the sessions that have access to your
          workspace.
        </p>
        <div className="actions">
          <a className="button" href={signedIn ? '/dashboard' : '/register'}>
            {signedIn ? 'Open workspace' : 'Create your account'} <span aria-hidden="true">→</span>
          </a>
          <a className="text-link" href="/login">
            Sign in to AuthCore
          </a>
        </div>
        <p className="quiet">
          {localDemo
            ? 'Private local environment. Verification emails stay in your test mailbox.'
            : 'Development preview. Availability depends on server configuration.'}
        </p>
      </section>
      <aside className="hero-panel" aria-label="Account security features">
        <div className="panel-head">
          <Mark />
          <span>Account protection</span>
          <span className="status-dot" />
        </div>
        <div className="feature">
          <span className="feature-number">01</span>
          <div>
            <h2>Verified identity</h2>
            <p>Confirm your email before account access.</p>
          </div>
        </div>
        <div className="feature">
          <span className="feature-number">02</span>
          <div>
            <h2>Private sessions</h2>
            <p>Access is checked by AuthCore on each request.</p>
          </div>
        </div>
        <div className="feature">
          <span className="feature-number">03</span>
          <div>
            <h2>Device control</h2>
            <p>Review your sessions and revoke access.</p>
          </div>
        </div>
        <div className="panel-foot">Built around explicit security boundaries</div>
      </aside>
    </div>
  );
}
function CredentialForm({ register }: { register: boolean }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false);
  // Same input retries reuse this key; changing either input starts a new attempt.
  // Neither credentials nor keys are persisted to browser storage.
  const key = useRef(crypto.randomUUID());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await request(
        register ? 'signup' : 'login',
        { email, password },
        register ? { 'idempotency-key': key.current } : {},
      );
      if (register) {
        if (
          !result ||
          typeof result !== 'object' ||
          !('status' in result) ||
          result.status !== 'accepted'
        )
          throw new ApiFailure(503);
        setPassword('');
        setAccepted(true);
      } else {
        accountResponse(result);
        setPassword('');
        window.location.assign('/dashboard');
      }
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-intro">
        <p className="eyebrow">AUTHCORE WORKSPACE</p>
        <h1>{register ? 'Start with a verified account.' : 'Welcome back.'}</h1>
        <p>
          {register
            ? 'A secure account starts with an email address you control. Confirm your email before signing in.'
            : 'Sign in to view your profile and manage the sessions that have access to your account.'}
        </p>
        <div className="intro-rule" />
        <p className="quiet">
          {localDemo
            ? 'You are using an isolated local demonstration. No external email is sent.'
            : 'Use your verified email and password to continue.'}
        </p>
      </section>
      <section className="auth-card" aria-labelledby="form-title">
        <h2 id="form-title">{register ? 'Create account' : 'Sign in'}</h2>
        {accepted ? (
          <>
            <Notice>
              If this address is eligible, a verification message will be available. Open the
              message and confirm your email to continue.
            </Notice>
            <MailboxLink />
            <a className="text-link block" href="/login">
              Continue to sign in →
            </a>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              required
              value={email}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.target.value);
                key.current = crypto.randomUUID();
              }}
              placeholder="you@example.com"
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              minLength={register ? 12 : 1}
              maxLength={384}
              required
              value={password}
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value);
                key.current = crypto.randomUUID();
              }}
              aria-describedby={register ? 'password-help' : undefined}
            />
            {register && (
              <p id="password-help" className="field-help">
                Use 12–128 characters. Spaces are preserved.
              </p>
            )}
            {error && <Notice error>{error}</Notice>}
            <button className="button full" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}{' '}
              <span aria-hidden="true">→</span>
            </button>
          </form>
        )}
        {!accepted && (
          <p className="form-switch">
            {register ? 'Already have an account?' : 'New to AuthCore?'}{' '}
            <a href={register ? '/login' : '/register'}>
              {register ? 'Sign in' : 'Create account'}
            </a>
          </p>
        )}
      </section>
    </div>
  );
}
function Verification({ token }: { token: string | undefined }) {
  const credential = useRef(token);
  const [busy, setBusy] = useState(false),
    [verified, setVerified] = useState(false),
    [error, setError] = useState('');
  async function verify() {
    if (busy || !credential.current) return;
    setBusy(true);
    setError('');
    try {
      const result = await request('verify-email', { token: credential.current });
      if (
        !result ||
        typeof result !== 'object' ||
        !('status' in result) ||
        result.status !== 'verified'
      )
        throw new ApiFailure(503);
      credential.current = undefined;
      setVerified(true);
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout centered">
      <section className="auth-card">
        <p className="eyebrow">EMAIL VERIFICATION</p>
        <h1>{verified ? 'Email confirmed.' : 'Confirm your email'}</h1>
        {verified ? (
          <>
            <Notice>Your email is verified. You can now sign in to your account.</Notice>
            <a className="button full" href="/login">
              Continue to sign in →
            </a>
          </>
        ) : credential.current ? (
          <>
            <p>
              Confirm to use the verification link from your email. Links expire after 30 minutes
              and can be used once.
            </p>
            {error && <Notice error>{error}</Notice>}
            <button className="button full" disabled={busy} onClick={() => void verify()}>
              {busy ? 'Verifying…' : 'Verify email'}
            </button>
          </>
        ) : (
          <>
            <Notice error>
              This verification link is missing or unavailable. Open the original message in your
              mailbox.
            </Notice>
            <MailboxLink />
            <a className="text-link block" href="/login">
              Return to sign in
            </a>
          </>
        )}
      </section>
    </div>
  );
}
function Workspace({
  account,
  page,
  onLogout,
}: {
  account: Account;
  page: string;
  onLogout: () => void;
}) {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const security = page === '/security',
    profile = page === '/profile';
  async function loadSessions() {
    setSessions(sessionResponse(await request('sessions')));
  }
  useEffect(() => {
    let active = true;
    void request('sessions')
      .then(sessionResponse)
      .then((value) => {
        if (active) setSessions(value);
      })
      .catch((error) => {
        if (active) setError(failureMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);
  async function revoke(path: string, body: unknown = {}) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(path, body);
      if (path === 'logout' || path === 'logout-all') onLogout();
      else await loadSessions();
    } catch (error) {
      setError(failureMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <p className="eyebrow">YOUR WORKSPACE</p>
        <nav aria-label="Account navigation">
          <a href="/dashboard" aria-current={!security && !profile ? 'page' : undefined}>
            Overview <span>↗</span>
          </a>
          <a href="/profile" aria-current={profile ? 'page' : undefined}>
            Profile
          </a>
          <a href="/security" aria-current={security ? 'page' : undefined}>
            Security &amp; sessions
          </a>
        </nav>
        <div className="sidebar-bottom">
          <span className="verified-dot" /> Email verified
        </div>
      </aside>
      <section className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">ACCOUNT WORKSPACE</p>
            <h1>
              {security
                ? 'Security & sessions'
                : profile
                  ? 'Your profile'
                  : 'Your account, at a glance.'}
            </h1>
            <p>
              {security
                ? 'Review access and end sessions you no longer use.'
                : profile
                  ? 'Your verified account information.'
                  : 'Welcome to your AuthCore workspace.'}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void revoke('logout')}
          >
            Sign out
          </button>
        </div>
        {error && <Notice error>{error}</Notice>}
        <div className="summary-grid">
          <article className="summary-card">
            <span className="eyebrow">ACCOUNT STATUS</span>
            <h2>
              Verified{' '}
              <span className="check-badge" aria-hidden="true">
                ✓
              </span>
            </h2>
            <p>Your email address is confirmed.</p>
          </article>
          <article className="summary-card">
            <span className="eyebrow">ACTIVE SESSIONS</span>
            <h2>{sessions ? sessions.length : '…'}</h2>
            <p>Sessions with current account access.</p>
          </article>
          <article className="summary-card accent-card">
            <span className="eyebrow">SESSION POLICY</span>
            <h2>30-minute idle limit</h2>
            <p>12-hour maximum session duration.</p>
          </article>
        </div>
        {!security && (
          <article className="content-card">
            <div className="section-heading">
              <h2>Account details</h2>
              <span className="pill">Verified account</span>
            </div>
            <dl className="profile-details">
              <div>
                <dt>Email address</dt>
                <dd>{account.email}</dd>
              </div>
              <div>
                <dt>Account created</dt>
                <dd>{date(account.createdAt)}</dd>
              </div>
              <div>
                <dt>Account ID</dt>
                <dd className="mono">{account.id}</dd>
              </div>
            </dl>
          </article>
        )}
        {!profile && (
          <article className="content-card">
            <div className="section-heading">
              <div>
                <h2>Active sessions</h2>
                <p>End access for devices you no longer recognize.</p>
              </div>
              <button
                className="text-button"
                disabled={busy || !sessions}
                onClick={() => void revoke('logout-others')}
              >
                Sign out other sessions
              </button>
            </div>
            {!sessions ? (
              <p role="status">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p>No active sessions. Sign in again to refresh your account access.</p>
            ) : (
              <ul className="session-list">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <div className="device-symbol" aria-hidden="true">
                      ▣
                    </div>
                    <div className="session-info">
                      <strong>
                        {session.deviceLabel === 'Other' ? 'Browser session' : session.deviceLabel}
                      </strong>
                      {session.current && <span className="pill">This session</span>}
                      <p>
                        Started {date(session.createdAt)} <span aria-hidden="true">·</span> Last
                        active {date(session.lastSeenAt)}
                      </p>
                    </div>
                    {!session.current && (
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() => void revoke('sessions/revoke', { sessionId: session.id })}
                      >
                        Revoke access
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {security && (
              <div className="danger-area">
                <div>
                  <h3>Sign out everywhere</h3>
                  <p>End every session, including this one. You will need to sign in again.</p>
                </div>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => void revoke('logout-all')}
                >
                  Sign out all sessions
                </button>
              </div>
            )}
          </article>
        )}
      </section>
    </div>
  );
}
