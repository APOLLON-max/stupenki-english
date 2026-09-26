-- Ступеньки English: облачное сохранение прогресса. Версия схемы 2.
-- Выполнить: Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Файл идемпотентный: подходит и для новой базы, и для обновления версии 1 (данные сохраняются).
--
-- Устройство:
--   progress — профиль: имя, bcrypt-хэш PIN, прогресс (JSON), счётчик неудачных входов.
--   sessions — токены устройств. Хранится только SHA-256 токена, сам токен знает лишь устройство.
-- PIN передаётся один раз при входе; дальше устройство работает по токену.
-- Обе таблицы закрыты RLS без политик и без прав для anon/authenticated:
-- доступ только через функции stupenki_* ниже (security definer).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.progress (
  name       text primary key,
  pin_hash   text not null,
  data       jsonb,
  updated_at timestamptz not null default now()
);
alter table public.progress add column if not exists failed_attempts int not null default 0;
alter table public.progress add column if not exists locked_until timestamptz;

create table if not exists public.sessions (
  token_hash text primary key,
  name       text not null references public.progress(name) on delete cascade,
  created_at timestamptz not null default now(),
  last_used  timestamptz not null default now()
);
create index if not exists sessions_name_idx on public.sessions (name);

alter table public.progress enable row level security;
alter table public.sessions enable row level security;
revoke all on table public.progress, public.sessions from anon, authenticated;

-- Функции версии 1: проверяли PIN на каждом запросе и не защищали от перебора.
drop function if exists public.load_progress(text, text);
drop function if exists public.save_progress(text, text, jsonb);
drop function if exists public.max_profiles();

-- Вход. Если имени нет — создаёт профиль (не больше 3 профилей всего).
-- После 5 неверных PIN подряд профиль блокируется: 15 мин, затем 30, 60… до суток.
-- Ответ: {status: ok | created | wrong_pin | locked | limit, token, data, seconds}
create or replace function public.stupenki_login(p_name text, p_pin text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  max_profiles constant int := 3;
  n   text := lower(trim(coalesce(p_name, '')));
  r   public.progress;
  tok text;
  created boolean := false;
begin
  if n = '' or length(n) > 30 or coalesce(p_pin, '') !~ '^\d{4,12}$' then
    return jsonb_build_object('status', 'wrong_pin');
  end if;

  select * into r from public.progress where name = n for update;
  if not found then
    if (select count(*) from public.progress) >= max_profiles then
      return jsonb_build_object('status', 'limit');
    end if;
    insert into public.progress (name, pin_hash) values (n, crypt(p_pin, gen_salt('bf', 8)));
    created := true;
  else
    if r.locked_until is not null and r.locked_until > now() then
      return jsonb_build_object('status', 'locked', 'seconds', ceil(extract(epoch from r.locked_until - now())));
    end if;
    if r.pin_hash <> crypt(p_pin, r.pin_hash) then
      update public.progress
         set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= 5
               then now() + make_interval(mins => least(1440, 15 * power(2, failed_attempts + 1 - 5))::int)
               end
       where name = n;
      return jsonb_build_object('status', 'wrong_pin');
    end if;
    update public.progress set failed_attempts = 0, locked_until = null where name = n;
  end if;

  tok := encode(gen_random_bytes(32), 'hex');
  insert into public.sessions (token_hash, name) values (encode(digest(tok, 'sha256'), 'hex'), n);
  -- не больше 10 устройств на профиль: самые старые сессии удаляются
  delete from public.sessions
   where name = n
     and token_hash not in (select token_hash from public.sessions where name = n order by last_used desc limit 10);

  return jsonb_build_object(
    'status', case when created then 'created' else 'ok' end,
    'token', tok,
    'data', case when created then null else r.data end);
end $$;

-- Загрузка прогресса по токену. Ответ: {status: ok | no_session, data, updated_at}
create or replace function public.stupenki_load(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n text;
  d jsonb;
  u timestamptz;
begin
  update public.sessions set last_used = now()
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  returning name into n;
  if n is null then
    return jsonb_build_object('status', 'no_session');
  end if;
  select data, updated_at into d, u from public.progress where name = n;
  return jsonb_build_object('status', 'ok', 'data', d, 'updated_at', u);
end $$;

-- Сохранение прогресса по токену (перезаписывает целиком). Ответ: {status: ok | no_session | too_big}
create or replace function public.stupenki_save(p_token text, p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('status', 'bad_data');
  end if;
  if octet_length(p_data::text) > 500000 then
    return jsonb_build_object('status', 'too_big');
  end if;
  update public.sessions set last_used = now()
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  returning name into n;
  if n is null then
    return jsonb_build_object('status', 'no_session');
  end if;
  update public.progress set data = p_data, updated_at = now() where name = n;
  return jsonb_build_object('status', 'ok');
end $$;

-- Выход: удаляет токен этого устройства.
create or replace function public.stupenki_logout(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  delete from public.sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return jsonb_build_object('status', 'ok');
end $$;

-- Права: по умолчанию Supabase открывает функции public всем ролям — закрываем и открываем только нужные.
revoke all on function public.stupenki_login(text, text)   from public, anon, authenticated;
revoke all on function public.stupenki_load(text)          from public, anon, authenticated;
revoke all on function public.stupenki_save(text, jsonb)   from public, anon, authenticated;
revoke all on function public.stupenki_logout(text)        from public, anon, authenticated;
grant execute on function public.stupenki_login(text, text) to anon, authenticated;
grant execute on function public.stupenki_load(text)        to anon, authenticated;
grant execute on function public.stupenki_save(text, jsonb) to anon, authenticated;
grant execute on function public.stupenki_logout(text)      to anon, authenticated;

-- Полезные команды (выполнять вручную при необходимости):
--   список профилей:        select name, updated_at, failed_attempts, locked_until from public.progress;
--   удалить профиль:        delete from public.progress where name = 'имя';
--   снять блокировку:       update public.progress set failed_attempts = 0, locked_until = null where name = 'имя';
--   выйти на всех устройствах: delete from public.sessions where name = 'имя';
--   сменить PIN:            update public.progress set pin_hash = extensions.crypt('новыйPIN', extensions.gen_salt('bf', 8)) where name = 'имя';
