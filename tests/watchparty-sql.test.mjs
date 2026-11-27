// Optional PostgreSQL integration test using PGlite (not a production dependency).
// Install @electric-sql/pglite separately, or set ZEUS_PGLITE_MODULE to its
// dist/index.js. Supabase Auth, Realtime and pgcrypto are deliberately stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

let PGlite;
try { ({ PGlite } = await import(process.env.ZEUS_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { /* optional local integration tool */ }

const host = '00000000-0000-4000-8000-000000000001';
const guest = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';

test('Postgres room functions enforce host authority, membership and reconnect rules', { skip: PGlite ? false : 'Install PGlite to run the optional SQL integration test' }, async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema realtime; create schema extensions;
      grant usage on schema auth, realtime, extensions to anon, authenticated;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub','')::uuid
      $$;
      create table realtime.messages (extension text, topic text, payload jsonb);
      alter table realtime.messages enable row level security;
      grant select, insert on realtime.messages to authenticated;
      create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
      create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language sql as $$ select $$;
      create function extensions.gen_random_bytes(integer) returns bytea language sql as $$
        select decode(substr(replace(gen_random_uuid()::text, '-', ''), 1, $1 * 2), 'hex')
      $$;
    `);
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261127142027_watch_party.sql', import.meta.url), 'utf8'));
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    async function asUser(id) {
      await db.exec('reset role');
      await query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: 'authenticated', sub: id })]);
      await db.exec('set role authenticated');
    }
    async function denied(fn) { await assert.rejects(fn); }

    await db.exec('set role anon');
    await denied(() => query("select public.zeus_party_create('x','vidspark','movie','123',1,1,'x')"));
    await asUser(host);
    const [{ snapshot: created }] = await query("select public.zeus_party_create('Host','vidspark','movie','533533',1,1,'Test film') as snapshot");
    const code = created.room.code;
    assert.match(code, /^[0-9A-F]{20}$/);
    assert.equal(created.you, host);
    assert.equal(created.room.host_id, host);
    await denied(() => query('select * from public.zeus_party_rooms'));
    await denied(() => query("insert into public.zeus_party_members(room_code, user_id, display_name) values ($1, $2, 'Fake')", [code, outsider]));
    await denied(() => query("select public.zeus_party_playback($1, null, 12)", [code]));
    await denied(() => query("select public.zeus_party_playback($1, 'seek', 'NaN'::float8)", [code]));
    await denied(() => query("select public.zeus_party_set_provider($1, null, 12)", [code]));
    await query("select public.zeus_party_playback($1, 'play', 12)", [code]);

    await asUser(guest);
    await denied(() => query('select public.zeus_party_snapshot($1)', [code]));
    const [{ snapshot: joined }] = await query("select public.zeus_party_join($1, 'Guest') as snapshot", [code]);
    assert.equal(joined.members.length, 2);
    await denied(() => query("select public.zeus_party_playback($1, 'pause', 18)", [code]));
    await denied(() => query("select public.zeus_party_set_provider($1, 'cinesrc', 18)", [code]));
    await denied(() => query('select public.zeus_party_end($1)', [code]));
    await query("select public.zeus_party_chat($1, 'Hi <img>')", [code]);
    await denied(() => query("select public.zeus_party_chat($1, 'too fast')", [code]));
    let [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.messages[0].body, 'Hi <img>');
    assert.equal(snapshot.messages[0].name, 'Guest');
    await db.exec('reset role');
    await query("insert into public.zeus_party_messages(room_code, user_id, display_name, body) select $1, $2, 'Host', 'filler-' || n from generate_series(1, 205) n", [code, host]);
    await query("update public.zeus_party_members set last_chat_at = clock_timestamp() - interval '2 seconds' where room_code = $1 and user_id = $2", [code, guest]);
    await asUser(guest);
    await query("select public.zeus_party_chat($1, 'Cap test')", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.messages.length, 50);
    assert.equal(snapshot.messages.at(-1).body, 'Cap test');
    await db.exec('reset role');
    assert.equal((await query('select count(*)::int as n from public.zeus_party_messages where room_code = $1', [code]))[0].n, 200);
    await asUser(guest);
    assert.equal((await query("select public.zeus_party_can_listen('zeus-party:' || $1) as allowed", [code]))[0].allowed, true);
    assert.equal((await query("select public.zeus_party_can_listen('zeus-party:WRONG') as allowed"))[0].allowed, false);

    // Exercise the actual realtime.messages RLS policy using a stub topic.
    await db.exec('reset role');
    await query("insert into realtime.messages(extension, topic, payload) values ('broadcast', $1, '{}'::jsonb)", ['zeus-party:' + code]);
    await asUser(guest);
    await query("select set_config('realtime.topic', $1, false)", ['zeus-party:' + code]);
    assert.equal((await query('select count(*)::int as n from realtime.messages'))[0].n, 1);
    await denied(() => query("insert into realtime.messages(extension, topic, payload) values ('broadcast', $1, '{}'::jsonb)", ['zeus-party:' + code]));
    await query("select set_config('realtime.topic', 'zeus-party:OTHER', false)");
    assert.equal((await query('select count(*)::int as n from realtime.messages'))[0].n, 0);
    await query('select public.zeus_party_leave($1)', [code]);
    await query("select set_config('realtime.topic', $1, false)", ['zeus-party:' + code]);
    assert.equal((await query('select count(*)::int as n from realtime.messages'))[0].n, 0);
    await denied(() => query('select public.zeus_party_snapshot($1)', [code]));
    await query("select public.zeus_party_join($1, 'Guest')", [code]);
    await asUser(outsider);
    await denied(() => query('select public.zeus_party_snapshot($1)', [code]));

    await asUser(host);
    await query("select public.zeus_party_set_provider($1, 'cinesrc', 21)", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.provider, 'cinesrc');
    assert.equal(snapshot.room.position_seconds, 21);
    assert.equal(snapshot.room.playing, false);
    await query("select public.zeus_party_playback($1, 'play', 21)", [code]);
    await query('select public.zeus_party_leave($1)', [code]);
    await asUser(guest);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.playing, false, 'explicit host departure freezes playback');
    await asUser(host);
    await query("select public.zeus_party_join($1, 'Host')", [code]);
    await query("select public.zeus_party_playback($1, 'play', 30)", [code]);
    await db.exec('reset role');
    await query("update public.zeus_party_members set last_seen = clock_timestamp() - interval '60 seconds' where room_code = $1 and user_id = $2", [code, host]);
    await asUser(guest);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.playing, false, 'a missing host does not advance the room indefinitely');
    await asUser(host);
    await query("select public.zeus_party_join($1, 'Host')", [code]);
    await query('select public.zeus_party_end($1)', [code]);
    await asUser(guest);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.ended, true);
    await denied(() => query("select public.zeus_party_join($1, 'Guest')", [code]));
    await denied(() => query("select public.zeus_party_chat($1, 'post end')", [code]));
  } finally { await db.close(); }
});
