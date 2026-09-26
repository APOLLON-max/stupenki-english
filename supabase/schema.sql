-- Ступеньки English: облачное сохранение прогресса.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.
--
-- Устройство: одна таблица (имя → PIN → прогресс в JSON) и две функции.
-- Таблица закрыта RLS без политик: напрямую её не прочитать даже с публичным ключом,
-- доступ только через функции, которые сверяют PIN на стороне базы.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.progress (
  name       text primary key,
  pin_hash   text not null,
  data       jsonb,
  updated_at timestamptz not null default now()
);

alter table public.progress enable row level security;

-- Сколько профилей можно создать (защита от посторонних, нашедших сайт).
create or replace function public.max_profiles() returns int
language sql immutable as $$ select 5 $$;

-- Загрузка прогресса. Если имени ещё нет — создаёт профиль с этим PIN.
-- Ответ: {status: ok | created | wrong_pin | limit, data, updated_at}
create or replace function public.load_progress(p_name text, p_pin text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n text := lower(trim(p_name));
  r public.progress;
begin
  if n = '' or length(n) > 30 or p_pin !~ '^\d{4,12}$' then
    return jsonb_build_object('status', 'wrong_pin');
  end if;
  select * into r from public.progress where name = n;
  if not found then
    if (select count(*) from public.progress) >= public.max_profiles() then
      return jsonb_build_object('status', 'limit');
    end if;
    insert into public.progress (name, pin_hash) values (n, crypt(p_pin, gen_salt('bf')));
    return jsonb_build_object('status', 'created', 'data', null);
  end if;
  if r.pin_hash <> crypt(p_pin, r.pin_hash) then
    return jsonb_build_object('status', 'wrong_pin');
  end if;
  return jsonb_build_object('status', 'ok', 'data', r.data, 'updated_at', r.updated_at);
end $$;

-- Сохранение прогресса (перезаписывает целиком, последняя запись побеждает).
create or replace function public.save_progress(p_name text, p_pin text, p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n text := lower(trim(p_name));
begin
  if octet_length(p_data::text) > 1000000 then
    return jsonb_build_object('status', 'too_big');
  end if;
  update public.progress
     set data = p_data, updated_at = now()
   where name = n and pin_hash = crypt(p_pin, pin_hash);
  if not found then
    return jsonb_build_object('status', 'wrong_pin');
  end if;
  return jsonb_build_object('status', 'ok');
end $$;

revoke all on function public.load_progress(text, text) from public;
revoke all on function public.save_progress(text, text, jsonb) from public;
grant execute on function public.load_progress(text, text) to anon, authenticated;
grant execute on function public.save_progress(text, text, jsonb) to anon, authenticated;
