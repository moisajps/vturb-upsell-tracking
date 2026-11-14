-- Integrador Kiwify → VTurb: faz a venda do upsell 1-click cair na VSL do upsell.
--
-- Toda venda da Kiwify chega primeiro na Edge Function `integrador-vturb`,
-- é gravada aqui (pedido bruto + decisão) e só depois é repassada para a VTurb.
-- Uma linha por (order_id, evento): se a Kiwify reenviar o mesmo evento, o
-- unique impede processar duas vezes.
--
-- Acesso só pelo service role (a Edge Function). RLS ligado e sem policies:
-- a chave pública (anon) não lê nem escreve nada aqui.

create table if not exists public.integrador_vturb (
  id              uuid primary key default gen_random_uuid(),
  order_id        text not null,
  order_ref       text,
  evento          text not null,              -- webhook_event_type (order_approved, order_refunded…)
  recebido_em     timestamptz not null default now(),
  email           text,
  checkout_link   text,                       -- identifica a oferta (front, upsell, downsell)
  produto         text,
  valor_cobrado   numeric(12,2),              -- Commissions.charge_amount / 100
  src_original    text,                       -- TrackingParameters.src como veio da Kiwify
  sessao_vturb    text,                       -- sessão extraída do src_original (v3_{sessão}_…)

  -- decisão do integrador
  tipo            text,                       -- upsell | downsell | outro
  regra           text,                       -- como o src foi decidido (ver README)
  src_enviado     text,                       -- src que foi para a VTurb (null = foi sem src)

  -- envio
  status          text not null default 'pendente'
                  check (status in ('pendente', 'enviado', 'erro')),
  tentativas      integer not null default 0,
  resposta_http   integer,
  ultimo_erro     text,
  enviado_em      timestamptz,

  signature       text,                       -- ?signature= original da Kiwify
  payload         jsonb not null,             -- corpo bruto do webhook

  unique (order_id, evento)
);

alter table public.integrador_vturb enable row level security;

-- busca da sessão pelo e-mail (upsell que chega sem src)
create index if not exists integrador_vturb_email_sessao_idx
  on public.integrador_vturb (email, recebido_em desc)
  where sessao_vturb is not null;

-- fila de novas tentativas
create index if not exists integrador_vturb_pendentes_idx
  on public.integrador_vturb (status, recebido_em)
  where status <> 'enviado';
