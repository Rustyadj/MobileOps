# Security notes

## Leaked seeded-admin credential — rotate before storing real data

Earlier revisions of this repo published a working admin login
(`admin@concreteform.com` / a specific password) in `memory/PRD.md` and
several files under `test_reports/`. The password has been redacted from the
current tree, but **redacting a file does not remove it from git history** —
anyone with clone access can still recover it from an old commit.

Treat that password as permanently compromised:

1. **Rotate it in every live deployment immediately.** Set a new
   `ADMIN_PASSWORD` (and ideally a new `ADMIN_EMAIL`) in the deployment's
   secret store, then restart the backend so `seed()` — actually, `seed()`
   only creates the admin user if one doesn't already exist for `ADMIN_EMAIL`,
   so also update the existing user's `password_hash` directly (or delete the
   user doc and let `seed()` recreate it) rather than assuming the env var
   change alone rotates a password that was already seeded into the database.
2. **Scrub the old password out of git history** if this repository (or any
   fork/clone of it) will keep storing real operational or customer data.
   This is a destructive, history-rewriting operation — it force-pushes a
   rewritten history to every branch and invalidates every existing clone —
   so do it deliberately, with the team's sign-off, using `git filter-repo`
   or BFG Repo-Cleaner, e.g.:
   ```
   git filter-repo --replace-text <(echo 'ChangeMe123!==>[REDACTED]')
   ```
   then force-push and have every collaborator re-clone. This was **not**
   done automatically as part of the fix that added this file — it needs an
   explicit decision from whoever owns the repository, since it rewrites
   shared history.
3. Going forward, `ADMIN_PASSWORD`/`ADMIN_EMAIL` are required environment
   variables with no default (see `backend/server.py`), and
   `backend/tests/conftest.py` reads them from the environment instead of
   falling back to a hardcoded value — so a real password should never again
   land in a committed file just by being "the test password."

## Self-service account creation

`POST /auth/signup` and the Google auto-provision path (`POST /auth/session`)
used to let anyone with any email address create a `crew` account with read
access to rentals, equipment, job sites, and contact info. Both are now
closed by default and only allow a new account when:
- the email's domain is in `SIGNUP_ALLOWED_DOMAINS` (comma-separated env var), or
- (signup only) the request includes an `invite_code` matching one in
  `SIGNUP_INVITE_CODES` (comma-separated env var).

With neither configured, self-service signup is fully disabled and accounts
must be created by an admin via `POST /auth/register`.
