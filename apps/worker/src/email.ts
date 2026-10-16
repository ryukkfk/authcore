import { verificationTokenDigest } from '@authcore/crypto';

export interface VerificationEmail {
  readonly eventId: string;
  readonly recipient: string;
  readonly token: string;
}
export interface EmailTransport {
  send(message: VerificationEmail, signal: AbortSignal): Promise<void>;
}

export function localHttpOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('LOCAL_MAILBOX_CONFIGURATION_INVALID');
  return url;
}

/** The only implemented transport captures mail locally; it has no SMTP relay. */
export class LocalMailboxTransport implements EmailTransport {
  private readonly mailbox: URL;
  private readonly web: URL;
  constructor(configuration: {
    readonly localDemo: true;
    readonly nodeEnvironment: string;
    readonly mailboxOrigin: string;
    readonly webOrigin: string;
  }) {
    if (configuration.localDemo !== true || configuration.nodeEnvironment !== 'development')
      throw new Error('LOCAL_MAILBOX_REQUIRES_EXPLICIT_DEVELOPMENT');
    this.mailbox = localHttpOrigin(configuration.mailboxOrigin);
    this.web = localHttpOrigin(configuration.webOrigin);
  }
  async send(message: VerificationEmail, signal: AbortSignal): Promise<void> {
    if (
      typeof message.recipient !== 'string' ||
      message.recipient.length > 254 ||
      /[\r\n]/.test(message.recipient) ||
      !message.recipient.includes('@') ||
      !verificationTokenDigest(message.token)
    )
      throw new Error('VERIFICATION_EMAIL_INVALID');
    // A fragment stays out of HTTP requests and access logs. The web client will
    // remove it before posting the credential in a bounded JSON request.
    const link = new URL('/verify', this.web);
    link.hash = 'token=' + message.token;
    const response = await fetch(new URL('/api/v1/send', this.mailbox), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        From: { Email: 'authcore@example.invalid', Name: 'AuthCore local demo' },
        To: [{ Email: message.recipient }],
        Subject: '[LOCAL DEMO ONLY] Verify your AuthCore email',
        Text:
          'This message was captured locally. No external email was sent.\n\nVerify your email within 30 minutes:\n' +
          link.toString(),
        Headers: { 'Message-ID': '<' + message.eventId + '@authcore.example.invalid>' },
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('LOCAL_MAILBOX_DELIVERY_FAILED');
  }
}
