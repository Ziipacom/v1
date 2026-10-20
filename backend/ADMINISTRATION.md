# Ziipa administration

The web portal and mobile app share **Account settings → Administration**.
On the website, `/admin` opens the same dashboard after checking the signed-in
account on the API. The dashboard never authenticates from an email allowlist,
client role, query string or request header.

| Role | Access |
| --- | --- |
| Member | Own creator tools; no administrative data |
| Moderator | Overview, published content/comments and report review |
| Admin | Moderator tools, users, account suspension, app settings and audit history |
| Owner | Admin tools and staff role assignment/revocation |

There is exactly one protected owner. The dashboard cannot replace, demote,
suspend or delete that account. Administrators cannot manage staff roles or
suspend other staff. Revoke a staff role before suspending its account.
Ownership recovery or transfer requires a separate reviewed operator procedure;
there is no public owner-claim endpoint or automatic first-user grant.

## Decisions and boundaries

Every management change requires a plain-text reason, an explicit review in the
UI and the current record version. Conflicting decisions return 409 and require
a refresh. The API rechecks the actor's current database permissions inside the
serialized decision transaction. Audit receipts and owner identity reject
database UPDATE/DELETE operations as well as ORM edits.

Content and comment moderation is reversible hiding, not permanent deletion.
Private drafts are excluded from content listings. Report triage does not
implicitly remove a post, delete a comment or contact an external network.
Already issued storage URLs can remain valid until their short expiry; Ziipa
cannot recall copies already downloaded or published on another platform.

Suspension blocks login, existing authenticated requests, discovery and fresh
automated publishing/agent handoffs. Notification devices are revoked. A provider action
already handed off cannot be recalled. Redis revocation failure does not undo
the SQL suspension; reactivation requires successful session purging so old
tokens cannot revive. The dashboard reports a pending revocation honestly.

App controls pause registrations, pause ordinary creator mutations for
maintenance, and display a plain-text announcement. Privacy controls, consent
revocation, sign-out and safety reports remain available during maintenance.
These controls do not edit hosting credentials, expose secrets, transfer wallet
funds, shut down already-running external streams or purchase services.
Previously approved private rendering/recording jobs and private calendar
tracking may finish; these controls are not a job-cancellation or stream-stop
operation. Public posting remains subject to fresh actor/source checks.

The old `MODERATOR_EMAILS` setting no longer grants privileges. Both legacy
moderation endpoints return 410: staff use the scoped Administration inbox
and provide a reason and current version instead of bypassing the audit trail.

## Explicit owner bootstrap

Deploy migration `20261020_0012` and the matching API/worker release first.
Identify the exact existing, verified account from its signed-in `/api/me`.
On the protected server configuration, run from `backend/`:

```sh
python -B bootstrap_owner.py --user-id EXISTING_ID --email EXISTING_EMAIL --reason 'Approved existing-account owner assignment'
```

This is a read-only dry run. Check `identity_matched`, `already_owner` and
`dry_run`. To apply that same explicit identity in production, add both
`--apply --allow-production`. The CLI never prints passwords, tokens or database
connection settings. It refuses an unverified production email, a mismatched identity, a suspended account or
replacement of a different owner. Repeating it for the same owner is safe.

Do not put the account email, database URL, password or bootstrap keys in source
control. No new login password is created; the existing account keeps its login.

## Coordinated deployment

The compact free scheduler enforces an exact schema revision and immutable
accepted image. An API-only migration would make the old worker fail its next
startup. Prepare and test a matching image before maintenance, preserve the old
source and native receipts, and coordinate the worker stop, migration and
accepted replacement. Never relax the schema guard or reuse an old native
receipt to claim acceptance of a different image. Keep hosting on free plans.

Migration downgrade intentionally refuses to erase the owner/audit tables.
Use a reviewed recovery or archival procedure rather than destructive rollback.
