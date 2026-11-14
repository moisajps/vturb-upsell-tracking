-- Reenvio automático: a cada 5 minutos, manda de novo para a VTurb o que falhou.
-- (Ex.: a VTurb fora do ar na hora da venda.) Cada venda tem até 6 tentativas.
--
-- Antes de rodar, troque:
--   SEU-PROJETO    → o ID do seu projeto Supabase (está na URL do painel)
--   SEU-SEGREDO    → o mesmo valor que você pôs no secret INTEGRADOR_CRON_SECRET

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'integrador-vturb-reprocessar',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://SEU-PROJETO.supabase.co/functions/v1/integrador-vturb?reprocessar=1',
    headers := '{"Content-Type": "application/json", "x-integrador-secret": "SEU-SEGREDO"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Para desligar: select cron.unschedule('integrador-vturb-reprocessar');
