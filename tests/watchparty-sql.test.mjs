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
    const migrations = new URL('../supabase/migrations/', import.meta.url);
    const files = fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    assert.equal(files[0], '20261127142027_watch_party.sql');
    await db.exec(fs.readFileSync(new URL(files[0], migrations), 'utf8'));
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    async function asUser(id) {
      await db.exec('reset role');
      await query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: 'authenticated', sub: id })]);
      await db.exec('set role authenticated');
    }
    async function denied(fn) { await assert.rejects(fn); }

    // Upgrade an already-active room instead of testing only an empty schema.
    await asUser(host);
    const [{ snapshot: legacy }] = await query("select public.zeus_party_create('Host','cinesrc','movie','123',1,1,'Existing') as snapshot");
    await query("select public.zeus_party_playback($1, 'play', 45)", [legacy.room.code]);
    await query("select public.zeus_party_chat($1, 'Existing message')", [legacy.room.code]);
    await asUser(guest);
    const [{ snapshot: beforeUpgrade }] = await query("select public.zeus_party_join($1, 'Guest') as snapshot", [legacy.room.code]);
    await db.exec('reset role');
    for (const file of files.slice(1)) await db.exec(fs.readFileSync(new URL(file, migrations), 'utf8'));
    await asUser(host);
    const [{ snapshot: afterUpgrade }] = await query('select public.zeus_party_snapshot($1) as snapshot', [legacy.room.code]);
    assert.equal(afterUpgrade.room.provider, beforeUpgrade.room.provider);
    assert.equal(afterUpgrade.room.playing, true);
    assert.equal(afterUpgrade.room.position_seconds, 45);
    assert.equal(afterUpgrade.room.state_updated_at, beforeUpgrade.room.state_updated_at);
    assert.equal(afterUpgrade.room.revision, beforeUpgrade.room.revision);
    assert.equal(afterUpgrade.room.source_sync, true);
    assert.equal(afterUpgrade.room.source_id, null);
    assert.equal(afterUpgrade.members.length, 2);
    assert.equal(afterUpgrade.messages[0].body, 'Existing message');
    await query('select public.zeus_party_end($1)', [legacy.room.code]);

    await db.exec('reset role');
    await db.exec('set role anon');
    await denied(() => query("select public.zeus_party_create('x','vidspark','movie','123',1,1,'x')"));
    await denied(() => query("select public.zeus_party_set_source('0123456789ABCDEF0123', 'cinesrc', 'wave', true)"));
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
    assert.equal(snapshot.room.source_sync, true);
    assert.equal(snapshot.room.source_id, null);
    const playbackUpdatedAt = snapshot.room.state_updated_at;
    await query("select public.zeus_party_set_source($1, 'cinesrc', 'ember', true)", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.source_id, 'ember');
    assert.equal(snapshot.room.state_updated_at, playbackUpdatedAt, 'source choice does not reset the playback clock');
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', E'bad\\nsource', true)", [code]));
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', repeat('x', 129), true)", [code]));
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', null)", [code]));
    await denied(() => query("select public.zeus_party_set_source($1, 'vidspark', 'source', true)", [code]));
    await denied(() => query("select public.zeus_party_set_source($1, 'bingeapi', '80', true)", [code]));
    await asUser(guest);
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', true)", [code]));
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.source_id, 'ember', 'guests read the host source but cannot change it');
    await asUser(host);
    await query("select public.zeus_party_set_source($1, 'cinesrc', null, false)", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.source_sync, false);
    assert.equal(snapshot.room.source_id, null);
    await query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', true)", [code]);
    await query("select public.zeus_party_set_provider($1, 'bingeapi', 21)", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.provider, 'bingeapi');
    assert.equal(snapshot.room.source_id, null, 'provider changes clear the old source');
    await denied(() => query("select public.zeus_party_set_source($1, 'bingeapi', 'unknown', true)", [code]));
    await query("select public.zeus_party_set_source($1, 'bingeapi', '80', true)", [code]);
    await query("select public.zeus_party_set_provider($1, 'vidora', 21)", [code]);
    [{ snapshot }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
    assert.equal(snapshot.room.provider, 'vidora');
    assert.equal(snapshot.room.source_id, null);
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'late-source', true)", [code]));
    await query("select public.zeus_party_set_provider($1, 'cinesrc', 21)", [code]);
    await query("select public.zeus_party_playback($1, 'play', 21)", [code]);
    await query('select public.zeus_party_leave($1)', [code]);
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', true)", [code]));
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
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', true)", [code]));
    await asUser(host);
    await denied(() => query("select public.zeus_party_set_source($1, 'cinesrc', 'wave', true)", [code]));
    for (const provider of ['bingeapi', 'vidora']) {
      const [{ snapshot: next }] = await query("select public.zeus_party_create('Host', $1, 'movie', '533533', 1, 1, 'Film') as snapshot", [provider]);
      assert.equal(next.room.provider, provider);
      await query('select public.zeus_party_end($1)', [next.room.code]);
    }
  } finally { await db.close(); }
});
