# B02 — Google Cloud setup runbook

Manual configuration that happens **outside this repository**. Nothing here is
automated by the PR, and no credential is ever committed.

Contract: [`B02_GMAIL_OAUTH_CONNECTION_CONTRACT.md`](B02_GMAIL_OAUTH_CONNECTION_CONTRACT.md).

---

## 1. Google Cloud project

1. Create or select a Google Cloud project for TheUGC.
2. **Enable the Gmail API** for it.
3. Configure the **OAuth consent screen**:
   - user type **External**;
   - app name, support email, developer contact;
   - add the `.../auth/gmail.readonly` scope — it is a **restricted** scope, and
     Google will ask for a justification;
   - add `openid` and `.../auth/userinfo.email`.
   - Do **not** add `gmail.send`. B02 does not request it; it belongs to a later
     incremental authorization when a sending feature exists.

## 2. OAuth client

Create an **OAuth client ID** of type **Web application**, and register the exact
redirect URIs. They must match character for character; Google does no prefix
matching.

| environment | redirect URI |
|---|---|
| local | `http://localhost:3000/api/integrations/gmail/oauth/callback` |
| production | `https://<your-domain>/api/integrations/gmail/oauth/callback` |

Download nothing into the repository. Copy the client id and secret into your
secret store.

## 3. Server environment

All four are **server-only**. None may be prefixed `NEXT_PUBLIC_`.

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://<your-domain>/api/integrations/gmail/oauth/callback
GMAIL_TOKEN_ENCRYPTION_KEY_V1=<base64 of 32 random bytes>
```

Generate the encryption key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

It must decode to exactly 32 bytes; the application refuses anything else at
startup of the first Gmail request. Never commit it, never log it, never send it
to the browser. Losing it makes every stored refresh token undecryptable — every
connected mailbox would need reconnecting.

If any of the four is absent, the rest of the application still builds, tests and
runs; only the Gmail endpoints fail closed with a controlled configuration error.

## 4. Test users while the app is in Testing

While the OAuth app is in **Testing** status, add each Google account that will
connect as an explicit **test user**. Others are refused by Google before they
ever reach our callback.

> **Testing-mode refresh tokens carrying Gmail scopes may expire after roughly
> seven days.** This is Google's behaviour, not a bug in B02. The mailbox moves
> to `reauth_required` and the creator reconnects — the application models this
> as ordinary lifecycle, and the flow is covered by tests.

## 5. Before broad production rollout

Still open, and still gated (carried forward from B01 §10):

- privacy policy on an owned, verified domain, plus terms;
- **OAuth brand verification**;
- **restricted-scope verification** for `gmail.readonly`, with a written scope
  justification and a demo video of the feature and the OAuth flow;
- the applicable **security assessment**;
- a working, demonstrable **deletion capability**;
- current developer and support contact information.

None of this is engineering, and none of it is performed by this PR.

## 6. Local smoke test — only with explicit authorization

Connecting a real Gmail account is a real authorization against a real person's
mailbox. Do it only when the project owner has explicitly asked for it and has
supplied credentials outside source control.

```bash
npm run dev
# sign in, then visit /app/account and use "Connect Gmail"
```

Expect: Google consent screen → callback → the consent step → `Connected`.
Then verify from `psql` that `private.gmail_oauth_credentials` holds exactly one
row for the mailbox and that its ciphertext contains nothing readable.
