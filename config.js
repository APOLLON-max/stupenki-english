// Облачное сохранение прогресса (Supabase).
// Оба поля пустые — прогресс хранится только в браузере этого устройства.
// Где взять: Supabase → Project Settings → API (Data API / API Keys).
// Публичный ключ (publishable / anon) можно хранить в коде: доступ к данным закрыт PIN-кодом,
// см. supabase/schema.sql. Секретный ключ (secret / service_role) сюда НЕ вставлять.
window.STUPENKI_CLOUD = {
  url: 'https://kwzsszsapdamyyvvnplc.supabase.co', // Project URL, например https://abcdefgh.supabase.co
  key: 'sb_publishable_4SvRWiCE0U3U1ry12RDtLw_rX3DstAW', // publishable (anon) key
};
