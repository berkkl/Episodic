# Security and data boundaries

API keys live in Worker secrets or local ignored environment files. The browser receives neither paid-model credentials nor TMDB credentials. Signing and invitation secrets are also server-only. Public source code is not a grant of access to a deployed instance.

Sessions use HMAC-signed HttpOnly, Secure, SameSite=Strict cookies. Signup requires an invite; write requests require an exact same-origin header. Viewing data, friends and AI endpoints require authentication. Friend views explicitly omit private shows, private entries, AI conversations and unannotated watch records. "Private from friends" does not exclude the owner's data from their own Ask profile: Ask sends that context to the configured provider.

The AI quota object serializes reservations across requests and locations. It fails closed, has per-user/global daily and burst limits, and counts failed provider attempts. No retry refund or automatic SDK retry can multiply paid calls outside the counter. Keep one quota namespace per deployment; deploying multiple independent copies does not share budgets. Configure a dedicated provider key with its own spending cap.

Known limits:

- Authentication throttling uses KV and is approximate under concurrent requests. Network/edge abuse controls are still appropriate for a publicly exposed host.
- Whole-diary writes are last-write-wins; stale devices can overwrite newer data. Previous documents are backed up, but there is no version/ETag conflict check yet.
- Friends use KV documents without multi-account transactions. The application is intended for a small invited group.
- Requests to TVmaze and poster/font hosts expose normal request metadata to those providers. Ask sends the signed-in user's profile to the configured AI provider; it is optional.
- Usage caps reduce cost exposure but do not guarantee uninterrupted availability or a specific bill.

Report suspected vulnerabilities through GitHub's private security reporting when available. Do not open a public issue containing keys, diaries, passwords or exploit requests against a live instance. Rotate exposed credentials before relying on repository cleanup alone.
