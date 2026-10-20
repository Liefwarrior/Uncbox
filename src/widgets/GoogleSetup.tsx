import { type FormEvent, type ReactNode, useState } from 'react';
import { openPage } from '../discord';
import { Icon } from '../components/Icon';
import { type GoogleDataError, type GoogleFeature, google, hasGoogleScopes, useGoogle } from './google';

// The screens every Google widget starts with: paste your Google client, sign in, and (when a
// widget was added after you signed in) allow the one new permission. Drive, Calendar and Gmail
// all use these; `feature` (see google.ts) holds the words that differ.

const STEPS = (feature: GoogleFeature): { text: string; page: 'google-credentials' | 'google-consent' | GoogleFeature['apiPage']; button: string }[] => [
  { text: 'Open Google Cloud Console and create a project (or pick one you have).', page: 'google-credentials', button: 'Open Cloud Console' },
  { text: `Turn on the ${feature.api} for that project.`, page: feature.apiPage, button: `Open ${feature.api}` },
  {
    text: `Set up the consent screen: choose External, then add your own Google address under Test users.${feature.consentHint ? ` ${feature.consentHint}` : ''}`,
    page: 'google-consent',
    button: 'Open consent screen',
  },
  { text: 'Create credentials: OAuth client ID, with the type Desktop app.', page: 'google-credentials', button: 'Open Credentials' },
];

/** The first step: paste the client ID and secret from Google Cloud Console. */
export function SetupClient({ feature, onCancel, onSaved }: { feature: GoogleFeature; onCancel?: () => void; onSaved?: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await google.saveClient(clientId, clientSecret);
      setClientSecret('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drive drive--setup no-drag">
      <h3>Connect {feature.name}</h3>
      <p className="muted">Uncbox signs in with your own Google client, so {feature.data} never go through anyone else. It takes a few minutes, once.</p>
      <ol className="drive__steps">
        {STEPS(feature).map((step) => (
          <li key={step.text}>
            {step.text}{' '}
            <button type="button" className="btn btn--small" onClick={() => openPage(step.page)}>
              {step.button}
            </button>
          </li>
        ))}
        <li>Paste the client ID and client secret here.</li>
      </ol>
      <form className="widget-settings" onSubmit={(e) => void submit(e)}>
        <label>
          Client ID
          <input data-setup="" value={clientId} placeholder="123456-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label>
          Client secret
          <input type="password" value={clientSecret} placeholder="GOCSPX-…" autoComplete="off" spellCheck={false} onChange={(e) => setClientSecret(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <span className="row">
          <button className="btn btn--small btn--accent" type="submit" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
            Save
          </button>
          {onCancel && (
            <button className="btn btn--small" type="button" onClick={onCancel}>
              Back
            </button>
          )}
        </span>
        <p className="hint">The secret stays in Uncbox’s data folder on this PC. It isn’t saved with your presets.</p>
      </form>
    </div>
  );
}

/**
 * The second step: Google's own page opens in the browser; this updates when it's done. With
 * `needsConsent` the person is already signed in and only the permission for this widget is new.
 */
export function SignIn({ feature, needsConsent, onCancel }: { feature: GoogleFeature; needsConsent: boolean; onCancel?: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    try {
      // Only this widget's permission is asked for, so signing in for one doesn't grant the others.
      await google.signIn(feature.scopes);
      setWaiting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start sign-in.');
    }
  };

  return (
    <div className="drive drive--setup no-drag">
      <h3>{needsConsent ? `Allow ${feature.access}` : 'Sign in with Google'}</h3>
      <p className="muted">
        {needsConsent
          ? `Uncbox needs permission to ${feature.permission}. Sign in again and tick the ${feature.box} box.`
          : `Your browser opens Google’s sign-in. Choose the account you added as a test user, and allow ${feature.box}.`}
      </p>
      <span className="row">
        <button className="btn btn--accent" onClick={() => void start()}>
          <Icon name="cloud" size={16} /> Sign in with Google
        </button>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Back
          </button>
        )}
      </span>
      {waiting && <p className="muted">Finish in your browser. This updates by itself when you’re done.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Shows the widget (`children`) once Google is set up, signed in and allowed for this feature,
 * and the right setup screen until then.
 */
export function GoogleGate({ feature, children }: { feature: GoogleFeature; children: ReactNode }) {
  const { status, reachable } = useGoogle();
  if (!reachable) return <p className="muted">{feature.name} needs Uncbox running on this PC.</p>;
  if (!status) return <p className="muted">Getting {feature.name}…</p>;
  if (!status.configured) return <SetupClient feature={feature} />;
  if (!hasGoogleScopes(status, feature.scopes)) return <SignIn feature={feature} needsConsent={status.signedIn} />;
  return <>{children}</>;
}

/** What to show for a failed request: the screen that fixes it, or the message. */
export function GoogleProblem({ feature, error }: { feature: GoogleFeature; error: GoogleDataError }) {
  if (error.code === 'scope' || error.code === 'signin') return <SignIn feature={feature} needsConsent={error.code === 'scope'} />;
  return (
    <div className="drive drive--setup no-drag">
      <p className="error">{error.message}</p>
      {error.code === 'api' && (
        <span className="row">
          <button className="btn btn--small" onClick={() => openPage(feature.apiPage)}>
            Open {feature.api}
          </button>
        </span>
      )}
    </div>
  );
}
