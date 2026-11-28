// Local PostgreSQL regression for the three already-applied ZEUS migrations.
// Auth, Realtime and pgcrypto are stubbed; this is not a live Supabase test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

let PGlite;
try { ({ PGlite } = await import(process.env.ZEUS_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { /* optional local test dependency */ }

const host = '00000000-0000-4000-8000-000000000101';
const guest = '00000000-0000-4000-8000-000000000102';
const outsider = '00000000-0000-4000-8000-000000000103';
const migrations = [
  '20261127142027_watch_party.sql',
  '20261127153149_watch_party_source_sync.sql',
  '20261127172021_watch_party_vidora_assist.sql'
];

test('existing room functions protect CineSrc membership, host controls and host reconnect',
  { skip: PGlite ? false : 'Install PGlite to run the optional SQL regression' }, async () => {
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
      const directory = new URL('../supabase/migrations/', import.meta.url);
      for (const name of migrations) await db.exec(fs.readFileSync(new URL(name, directory), 'utf8'));
      const query = async (sql, args = []) => (await db.query(sql, args)).rows;
      async function asUser(id) {
        await db.exec('reset role');
        await query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: 'authenticated', sub: id })]);
        await db.exec('set role authenticated');
      }
      const denied = fn => assert.rejects(fn);

      await db.exec('set role anon');
      await denied(() => query("select public.zeus_party_create('Host','cinesrc','movie','123',1,1,'Film')"));
      await asUser(host);
      const [{ snapshot: created }] = await query("select public.zeus_party_create('Host','cinesrc','movie','123',1,1,'Film') as snapshot");
      const code = created.room.code;
      assert.match(code, /^[0-9A-F]{20}$/);
      assert.equal(created.room.provider, 'cinesrc');
      assert.equal(created.room.host_id, host);
      await db.exec('reset role');
      await query("insert into realtime.messages(extension, topic, payload) values ('broadcast',$1,'{}'),('presence',$1,'{}')", ['zeus-party:' + code]);
      await asUser(host);
      await query("select set_config('realtime.topic',$1,false)", ['zeus-party:' + code]);
      assert.equal((await query('select * from realtime.messages where topic = $1', ['zeus-party:' + code])).length, 1);
      await denied(() => query("insert into realtime.messages(extension, topic, payload) values ('broadcast',$1,'{}')", ['zeus-party:' + code]));
      await denied(() => query('select * from public.zeus_party_rooms'));
      await denied(() => query('select * from public.zeus_party_members'));
      await denied(() => query('select * from public.zeus_party_messages'));
      await query("select public.zeus_party_playback($1,'play',12)", [code]);

      await asUser(guest);
      await denied(() => query('select public.zeus_party_snapshot($1)', [code]));
      const [{ snapshot: joined }] = await query("select public.zeus_party_join($1,'Guest') as snapshot", [code]);
      assert.equal(joined.members.length, 2);
      await denied(() => query("select public.zeus_party_playback($1,'pause',13)", [code]));
      await denied(() => query("select public.zeus_party_playback($1,'seek',40)", [code]));
      await denied(() => query('select public.zeus_party_end($1)', [code]));
      await query("select public.zeus_party_chat($1,'Hello')", [code]);
      assert.equal((await query("select public.zeus_party_can_listen('zeus-party:' || $1) as allowed", [code]))[0].allowed, true);
      assert.equal((await query('select * from realtime.messages where topic = $1', ['zeus-party:' + code])).length, 1);

      await asUser(outsider);
      await denied(() => query('select public.zeus_party_snapshot($1)', [code]));
      assert.equal((await query("select public.zeus_party_can_listen('zeus-party:' || $1) as allowed", [code]))[0].allowed, false);
      assert.equal((await query('select * from realtime.messages where topic = $1', ['zeus-party:' + code])).length, 0);
      await denied(() => query("select public.zeus_party_chat($1,'Not a member')", [code]));

      // Simulate a stale host heartbeat in the isolated database. A guest
      // snapshot freezes the room but cannot transfer host authority.
      await db.exec('reset role');
      await query("update public.zeus_party_members set last_seen = clock_timestamp() - interval '60 seconds' where room_code = $1 and user_id = $2", [code, host]);
      await asUser(guest);
      const [{ snapshot: stale }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
      assert.equal(stale.room.playing, false);
      assert.equal(stale.room.host_id, host);
      assert.equal(stale.members.find(member => member.host).online, false);
      await denied(() => query("select public.zeus_party_playback($1,'play',40)", [code]));
      await asUser(host);
      await query('select public.zeus_party_heartbeat($1)', [code]);
      await query("select public.zeus_party_playback($1,'play',40)", [code]);
      await query("select public.zeus_party_playback($1,'seek',40)", [code]);
      await query("select public.zeus_party_playback($1,'pause',40)", [code]);
      await query('select public.zeus_party_leave($1)', [code]);
      await asUser(guest);
      const [{ snapshot: departed }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
      assert.equal(departed.room.host_id, host);
      assert.equal(departed.room.playing, false);
      assert.equal(departed.messages[0].body, 'Hello');
      await denied(() => query("select public.zeus_party_playback($1,'play',40)", [code]));
      await asUser(host);
      const [{ snapshot: rejoined }] = await query("select public.zeus_party_join($1,'Host') as snapshot", [code]);
      assert.equal(rejoined.you, host);
      assert.equal(rejoined.room.host_id, host);
      await query("select public.zeus_party_playback($1,'play',40)", [code]);
      await query('select public.zeus_party_end($1)', [code]);
      await asUser(guest);
      const [{ snapshot: ended }] = await query('select public.zeus_party_snapshot($1) as snapshot', [code]);
      assert.equal(ended.room.ended, true);
    } finally { await db.close(); }
  });
