# Read-only connections and verifier receipts

GitHub uses a dedicated GitHub App with **Issues: read** and **Metadata: read**. Enable user authorization during installation, set the callback URL to `https://YOUR_APP/api/v1/connections/github/callback`, and configure the app ID, slug, client ID/secret and private key on the server. The callback confirms that the authorizing user can access the selected installation and that it belongs to this App. It rejects write permissions. Installation IDs alone are never sufficient proof of access. See [GitHub App installation access](https://docs.github.com/en/rest/apps/installations).

HubSpot uses OAuth with `crm.objects.contacts.read`. Set its redirect URL to `https://YOUR_APP/api/v1/connections/hubspot/callback`. Token exchange and refresh use the form-encoded v3 OAuth endpoints; refresh is serialized and credentials are re-encrypted. Additional write scopes are rejected. See [HubSpot OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth).

Configure the provider before choosing Connect in the application. OAuth state is random, hashed, browser-bound, user-bound, tenant-bound, expires after ten minutes, and is consumed once. Current workspace membership is checked again on callback. Credentials never appear in list responses. Disconnect deletes the platform's credential; uninstall/revoke access in the provider account when remote authorization must also end.

Production uses envelope encryption: a fresh AES-256-GCM data key per credential, wrapped by a KMS key in `ap-southeast-1`, with workspace/project authenticated context. IAM must allow only the configured key and the runtime's workload identity. Local encryption derives a key from `LOCAL_ENCRYPTION_KEY` or the development session secret and is refused in production. Rotation is done by reauthorization; KMS wrapping keys can rotate without exposing plaintext credentials.

Verifier requests are restricted to fixed provider API hosts, HTTPS, bounded timeouts, and no redirects. GitHub queries one issue; HubSpot queries one contact and only configured properties. A maximum of three attempts handles eventual consistency. A 404, permission failure or unavailable field is unknown. Observations retain exact timestamps and filtered, redacted properties. The worker freezes observations for replay, so historical evaluation does not re-query a changed production resource.

## Customer-operated verifier

Create a key with only the `verifier` scope. It is separate from ingestion and CI credentials. Submit `receiptId`, `projectId`, `runId`, `outcomeId`, `observedAt`, `resourceId`, `properties`, and `status` to `/v1/evidence`.

Headers: `Authorization: Bearer KEY`, `x-receipt-timestamp: UNIX_SECONDS`, and `x-receipt-signature: HEX_HMAC_SHA256(KEY, timestamp + "." + raw_UTF8_JSON_body)`. Sign the exact decompressed body bytes. The signature timestamp must be within five minutes. Both SDKs provide a helper. An old observation may be submitted now, but its observation window still governs verification. Identical receipt IDs are idempotent; conflicts reject with 409. Their provenance remains `customer_verifier`.

## External acceptance still required

Local tests use provider protocol fixtures. Before production release, connect real read-only sandbox accounts and verify existence, changed properties, expired permissions, stale observations and reauthorization for both providers. No live sandbox record has been checked by the local suite.
