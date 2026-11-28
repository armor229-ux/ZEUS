# Optional live authorization checks

These checks intentionally make a few real requests to the **existing** ZEUS
Supabase project. Run them only after checking included quota, in a disposable
test room, using the guest's separate browser profile. They do not create a new
project or require a private key. Never send session tokens, WebSocket frames,
room codes or screenshots containing them to anyone.

First confirm the party page says **GUEST** and the player is joined. In that
guest page's developer-tools console, run the following. It attempts a host-only
pause at time zero, so it must be used only in a disposable room. If authorization
is correct, the database rejects the request with code `42501` and playback is
unchanged. Any other error is inconclusive, not a pass.

```js
(async () => {
  if (document.querySelector('#room-role')?.textContent.trim() !== 'GUEST') {
    console.log('INCONCLUSIVE: join as a guest in a separate profile first.');
    return;
  }
  const room = new URLSearchParams(location.hash.slice(1)).get('party');
  if (!room) { console.log('INCONCLUSIVE: no room code in this tab.'); return; }
  window.__zeusTestRoom = room;
  window.__zeusPermissionCheck = async (name, body) => {
    if (!['zeus_party_playback', 'zeus_party_snapshot'].includes(name)) return;
    try {
      const session = JSON.parse(sessionStorage.getItem('zeus_party_auth_v1') || 'null');
      if (!session?.access_token) { console.log('INCONCLUSIVE: guest session missing.'); return; }
      const response = await fetch('https://gqjgmniwvqcpsurzmbet.supabase.co/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
          apikey: 'sb_publishable_74MGBFkvRcyd_uoJ1DLSnQ_yj4ap7mg',
          authorization: 'Bearer ' + session.access_token,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) console.log('FAIL: the request unexpectedly succeeded. Stop the test.');
      else if (response.status === 403 && result.code === '42501') console.log('PASS: request denied by the server.');
      else console.log('INCONCLUSIVE: request failed for another reason.');
    } catch (error) { console.log('INCONCLUSIVE: the service could not be reached.'); }
  };
  await window.__zeusPermissionCheck('zeus_party_playback', {
    p_code: room, p_action: 'pause', p_time: 0
  });
})();
```

Next click **Leave party** in that same guest tab. Without reloading it, run:

```js
await window.__zeusPermissionCheck('zeus_party_snapshot', { p_code: window.__zeusTestRoom });
```

This should also report `PASS`: a session which has left cannot read the room
snapshot. A network, configuration or other error is inconclusive.

While still in that same guest tab **after leaving**, this optional check tries
joining the private Realtime channel using the same session. It reports a pass
only for an explicit permission error; a network failure or timeout is
inconclusive. First verify that the guest actually received a `changed`
Broadcast while it was a member, as described in the main test instructions.

```js
(async () => {
  const room = window.__zeusTestRoom;
  if (!room || document.querySelector('#room')?.hidden !== true) {
    console.log('INCONCLUSIVE: leave the test room first.'); return;
  }
  const client = window.supabase.createClient(
    'https://gqjgmniwvqcpsurzmbet.supabase.co',
    'sb_publishable_74MGBFkvRcyd_uoJ1DLSnQ_yj4ap7mg',
    { auth: { storage: sessionStorage, storageKey: 'zeus_party_auth_v1',
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) {
      console.log('INCONCLUSIVE: guest session missing.'); return;
    }
    await client.realtime.setAuth(data.session.access_token);
    const channel = client.channel('zeus-party:' + room, { config: { private: true } });
    let finished = false;
    const timer = setTimeout(() => finish('TIMED_OUT'), 15000);
    function finish(status, reason) {
      if (finished || !['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) return;
      finished = true; clearTimeout(timer);
      if (status === 'SUBSCRIBED') console.log('FAIL: nonmember joined the private channel. Stop the test.');
      else if (status === 'CHANNEL_ERROR' && /unauthori[sz]ed|permission|not.?authori[sz]ed|forbidden/i.test(reason?.message || '')) {
        console.log('PASS: private channel denied to the nonmember.');
      } else console.log('INCONCLUSIVE: no explicit permission denial was received.');
      client.removeChannel(channel);
    }
    channel.subscribe(finish);
  } catch (error) { console.log('INCONCLUSIVE: the service could not be reached.'); }
})();
```

The helpers print neither the code nor the Auth session. Delete the temporary
in-page helpers when done:

```js
delete window.__zeusPermissionCheck;
delete window.__zeusTestRoom;
```

These checks have **not** been performed against live Auth or Realtime in this
sandbox. A subscription status alone does not prove that Broadcasts arrived.
