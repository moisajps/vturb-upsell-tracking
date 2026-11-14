# Regras do integrador

## Decisão do `src`

Entrada: o pedido da Kiwify. Saída: `{ tipo, regra, src }`.

```
destino = INTEGRADOR_DESTINOS[pedido.checkout_link]
se não há destino                       → fora_do_funil, src original
lido = lerSrc(TrackingParameters.src)   // { sessao, player } ou null
se lido.player == destino.player        → ja_no_upsell, src original
se lido                                 → trocado_player, v3_{lido.sessao}_{destino.player}_0
sessao = sessão mais recente do mesmo e-mail nas últimas 24h (tabela do integrador)
se sessao                               → sessao_por_email, v3_{sessao}_{destino.player}_0
senão                                   → sem_sessao, src null
```

`lerSrc`: `/^v3_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{24})(?:_|$)/i`, sessão e player em minúsculas.

### Por que 24h na busca por e-mail
O upsell 1-click acontece minutos depois do front. Uma janela curta evita pegar a sessão de uma compra antiga, de outro aparelho.

### Por que a sessão do front serve para o upsell
A sessão da VTurb fica no `localStorage` do domínio e é a mesma em todas as páginas do domínio, no mesmo navegador, por dias. Quem comprou o front e assistiu a VSL do upsell tem a mesma sessão. Domínios diferentes geram sessões diferentes.

### Downsell
Se tem VSL própria, use o player dela. Se não tem, use o player do upsell da mesma etapa: a pessoa assistiu o upsell, recusou e comprou o downsell, então foi aquele vídeo que vendeu. Um downsell fora de `INTEGRADOR_DESTINOS` segue como `fora_do_funil`, com o `src` herdado do front (cai na VSL do front).

## Envio

- Uma decisão por pedido, gravada antes do primeiro envio e reusada nas tentativas seguintes.
- Até 6 tentativas; o reprocessamento ignora linhas com menos de 2 min (dá tempo do envio em segundo plano terminar).
- Status: `pendente` → `enviado` (HTTP 2xx da VTurb) ou `erro` (com `resposta_http` e `ultimo_erro`).

## Acompanhamento

```sql
-- Últimas vendas
select recebido_em, order_ref, evento, produto, tipo, regra, status, resposta_http, ultimo_erro
from integrador_vturb order by recebido_em desc limit 50;

-- Pendências
select order_ref, evento, tentativas, resposta_http, ultimo_erro
from integrador_vturb where status <> 'enviado' order by recebido_em;

-- Upsells por regra (7 dias)
select regra, count(*), sum(valor_cobrado)
from integrador_vturb
where tipo in ('upsell', 'downsell') and evento = 'order_approved'
  and recebido_em > now() - interval '7 days'
group by 1 order by 2 desc;
```

`sem_sessao` alto: compras de upsell cujo front não passou pelo integrador (ex.: front antes de ligar o integrador), ou com e-mail diferente.

## Casos de borda

- **Evento sem `order_id`** (carrinho abandonado etc.): responda 200 e ignore.
- **Corpo pode vir como `{ order: {...} }`** ou o pedido direto: use `bruto.order ?? bruto`.
- **Reembolso/chargeback** chegam como outros `webhook_event_type` do mesmo `order_id`: passam pelas mesmas regras (o reembolso do upsell sai da VSL do upsell).
- **Troca de vídeo do upsell:** um pedido antigo reprocessado depois da troca vai para o vídeo novo. Só acontece com pedidos que falharam por horas.
- **Vendas anteriores ao integrador:** não são corrigíveis; a VTurb ignora `order_id` repetido.
