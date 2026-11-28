# ZEUS CineSrc Watch Party

**Implementation status:** this repository contains a CineSrc-only party
client, but its real two-browser operation against CineSrc and Supabase has
**not** been verified in this sandbox. Do not treat local fixture tests as proof
of live synchronization. This client requires no additional database migration.

## What is active

- Normal viewing remains in `watch.html` / `watch.js`, with Vidora as before.
  The Party button navigates in the **same tab** to the existing `party.html`
  path; it stops the normal player and any in-flight hidden server probe before
  navigation. The separate party page contains no normal player or video file.
- `party.html` loads `watchparty-cinesrc-player.js` and
  `watchparty-cinesrc.js`. The party client offers and requests CineSrc only;
  it does not present a provider selector or switch to another provider on an
  error. A healthy host resync shares its current state without reloading;
  when retrying an unresponsive player, ZEUS destroys the old iframe before
  mounting a replacement. Navigating away also destroys the party iframe,
  including when the page enters the browser's back/forward cache.
- CineSrc documents `play`, `pause`, `seek`, getter responses and player events
  through `postMessage` at <https://cinesrc.st/docs>. The client validates the
  iframe origin and window before processing events. The player’s own
  `lastserver` option is only a **preference**; ZEUS does not select, lock or
  guarantee CineSrc's internal sources. Autoplay, title availability, buffering
  and accurate timing depend on CineSrc and each browser.
- Each participant connects to CineSrc directly. The room service stores title
  metadata, party state, names and chat; it does not host, proxy or relay video.
  Only watch and share content you are authorized to use. Checking the rights
  box is a user confirmation, not a way to verify rights.

The earlier in-player `watchparty.js` / `watchparty-player.js` and the old
Worker `party.js` remain in the repository as historical code; this party page
does **not** load them. Other local direct-video or native-player drafts and
bundled media are not part of this feature. The existing `party.html` path is
used for the separate CineSrc page rather than the Worker client; no route
configuration was changed.

## Supabase and security

The client uses only the existing ZEUS project and its existing *publishable*
browser key. It calls the previously installed `zeus_party_*` functions from
`20261127142027_watch_party.sql`, `20261127153149_watch_party_source_sync.sql`
and `20261127172021_watch_party_vidora_assist.sql`. Those migrations define
RLS-protected tables with direct client table privileges revoked, authenticated
membership checks, and server-side host checks for playback and room closure.
Realtime private Broadcast carries only a wakeup; the client fetches room data
through the checked snapshot RPC and also polls if Realtime is unavailable.
No new migration is needed for this client change, and no SQL was applied.
A read-only inspection of the configured project's metadata found RLS enabled
and direct anonymous/authenticated table privileges revoked for all three party
tables, with a private Broadcast read policy using the membership helper. The
installed playback and end-function definitions contain host and membership
checks. Live end-to-end authorization and Realtime delivery still require
real-service testing.

The legacy RPCs remain available to legacy clients and can create rooms with
other provider values. This client always requests `cinesrc`, rejects an
incompatible invite and destroys its player if a room later changes provider.
It never loads the other provider. Enforcing a provider-only restriction for
*all* existing database clients would require a separate reviewed database
change and could affect legacy rooms; this implementation does not alter it.

The random 20-hex-character code is a bearer invite. Anyone with it and an
eligible authenticated session can join and read that room's names and chat;
share it only with trusted people. New links keep the code in the URL fragment.
The anonymous Auth session is kept in the same tab's `sessionStorage`, so a
network disconnect or reload can preserve the original host identity. Guests
are never promoted. Losing the session (for example, closing the tab or clearing
storage) can prevent host recovery. Duplicated tabs may copy session storage;
use separate browser profiles for independent viewers. Other scripts running on
the same ZEUS origin can access origin-scoped browser storage, so the wider
origin and its third-party scripts should be audited before treating the room as
confidential.

## Cost and live testing prerequisites

The user reported the existing project is on Free, but current usage, available
quota and remaining headroom were not visible through the connector. **Check
the actual usage dashboard before a real test and stop if sufficient included
quota cannot be verified.** In particular check Realtime messages and concurrent
connections, egress, database storage and Auth monthly active users. Do not
create projects, branches, paid services or request credentials in chat.

A foreground client polls a room about 720 times/hour and sends about 200
heartbeats/hour; a playing host may send up to about 360 periodic state updates
per hour, plus interactive actions, reconnects and Realtime wakeups. These are
rough estimates, not a quota guarantee. Anonymous sign-ins create Auth users;
room data has the existing lazy expiration/cleanup behavior, while Auth users
need their own retention/cleanup policy. Existing rate limits do not guarantee
protection from anonymous-signup or room-creation abuse. Review abuse controls
before a public launch; enabling CAPTCHA also requires client token handling.
Test sparingly and monitor the actual dashboard. The sandbox's direct HTTPS
connection to CineSrc and the ZEUS Supabase endpoint failed with
`SSL_ERROR_SYSCALL`; the real testing browser
needs working HTTPS/WSS access to the project and access to CineSrc and its
actual sources. The connector labeled Realtime healthy but reported
`db_connected: false`, `replication_connected: false`, and
`connected_cluster: 0`; those diagnostics do not establish whether private
Broadcast delivery works. Polling is a degraded fallback, not proof of it.

## Simple manual test after checking quota

1. After the CineSrc feature has been deployed, open
   <https://zeus-self.vercel.app/party.html> and confirm it displays the CineSrc
   party lobby. Until then, that URL may show the older Worker client instead.
   Alternatively, for local-only testing, run
   `node tests/watchparty-cinesrc-static-server.mjs` from the repository root
   and open `http://localhost:4186/`. This optional server serves no local video
   files or preserved party drafts and does not proxy CineSrc or Supabase.
2. Open a title you are authorized to share, select **Watch Party**, confirm
   the details and rights, and start a party. Alternatively use the party page
   directly and enter the title and TMDB ID.
3. Copy the invite. Open it in a **separate browser profile** (not a duplicated
   tab), enter a different name and join. Also try joining by the displayed code.
   Check both participants and send chat in both directions.
4. In the host's CineSrc player, try play, pause and seek; verify the guest
   actually follows. Try guest controls and verify they do not change the host
   or room. Use **Resync**, and confirm only one party player is audible.
5. Disconnect and reconnect each browser; reload the host's same tab and verify
   it remains host. Confirm the guest is never promoted. Check unavailable
   titles/errors and autoplay prompts; ZEUS must not switch to another provider.
6. To check Realtime delivery rather than just polling, open the guest browser's
   developer tools, select the Supabase Realtime WebSocket under Network → WS,
   and check for a `changed` Broadcast when the host acts. A **Connected** label
   alone does not prove that wakeups arrived. Avoid sharing WebSocket frames,
   session data or invite codes: they may contain sensitive information.
7. Optionally run the [guest authorization checks](cinesrc-live-authorization-check.md)
   in a disposable test room. Leave the guest and end the room when finished.

If either service, anonymous Auth, private Realtime, the chosen title or a
browser cannot be reached, record that blocker instead of assuming sync works.
The local server is for testing only; no Vercel or Cloudflare configuration is
changed by it. It binds to port 4186 by default (`PORT` may override it).
