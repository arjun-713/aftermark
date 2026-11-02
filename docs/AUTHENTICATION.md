# Authentication setup

The reproducible local stack and configured Singapore project are described in [Supabase setup](SUPABASE.md). `npm run supabase:verify` exercises actual local email confirmation/PKCE, JWKS and sessions; `npm run supabase:verify:hosted` checks real hosted Auth, tenant isolation and Storage without sending mail.

Local development uses the two seeded accounts in `.env.example` mode. Production refuses local authentication and the development signing secret. Set `AUTH_MODE=supabase`, a private `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and an HTTPS `WEB_ORIGIN`. Keep service-role and database migration credentials outside web/API runtime roles.

In Supabase Auth, allow the exact redirect `https://YOUR_HOST/api/v1/auth/callback`. Enable email/password authentication and configure the confirmation email transport; Resend can supply Supabase's SMTP transport. Sign-up uses a PKCE exchange with a ten-minute signed, HTTP-only browser cookie. Email confirmation must be opened in the originating browser. If the pending cookie expires, sign in after confirming your email.

For Google or GitHub sign-in, configure the corresponding provider in Supabase and its OAuth application callback as documented by [Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) or [GitHub setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-github). The provider's callback is `https://PROJECT_REF.supabase.co/auth/v1/callback`; this is distinct from the application's `/api/v1/auth/callback`. Set `SUPABASE_GOOGLE_ENABLED=true` or `SUPABASE_GITHUB_ENABLED=true` after provider setup. The API checks Supabase's actual provider settings, caches availability for 30 seconds, and rejects an unavailable provider. A flag alone cannot advertise a working login method. Both providers share the signed PKCE callback and internal return-path validation. GitHub sign-in is separate from the read-only GitHub Issues connection used for verification.

Google and GitHub activation is currently deferred at the owner's request. Email signup and sign-in remain the active methods; the app does not present inactive provider buttons.

The API stores access and refresh tokens in HTTP-only, same-site cookies; production cookies have the `__Host-` prefix, Secure, and Path=/. They are never stored in browser local storage. A single shared browser refresh request handles concurrent expired-access requests. Logout expires all authentication and pending PKCE cookies. User roles are read from the database on every authorized request, so membership revocation applies to existing sessions.

Internal return paths are limited to `/app` and its descendants. Invitation tokens are captured in memory and removed from the visible URL before acceptance. OAuth/confirmation failure returns to the sign-in page without exposing provider errors or tokens.

Live email confirmation, GitHub sign-in, refresh-token rotation, and Supabase provider configuration must be exercised in staging before launch. Local accounts and protocol tests do not establish those external gates.
