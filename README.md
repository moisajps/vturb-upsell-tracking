# VTurb Upsell Tracking: conversão do upsell 1-click na VSL certa

Se você vende com **upsell 1-click**, seja na Kiwify ou em qualquer outra plataforma, e está notando que **as conversões do upsell não estão sendo marcadas na sua VSL de upsell na VTurb**, este material é para você.

Na maioria dos casos, as vendas do upsell estão caindo na **VSL do front** ou em VSL nenhuma. A VSL do front parece vender mais do que vende, a do upsell parece não vender, e um teste A/B no upsell fica impossível de ler.

A solução é um **integrador**: um pequeno serviço que fica entre a sua plataforma de vendas e a VTurb e corrige o código de rastreio de cada venda antes de ela chegar na VTurb.

> **Plataformas:** a lógica vale para qualquer plataforma com upsell 1-click que mande as vendas para a VTurb por webhook. O código pronto deste repositório é para a **Kiwify**, onde a solução foi testada. Para outra plataforma, o formato do webhook muda: a skill do Claude Code faz essa adaptação (veja [Outras plataformas](#outras-plataformas)).

> **Usa o Claude Code?** Instale a skill e peça para ele montar tudo no seu projeto:
> ```bash
> npx skills add moisajps/vturb-upsell-tracking
> ```
> Depois é só pedir: *"monta o integrador da VTurb para o meu upsell"*. Veja a seção [Com o Claude Code](#com-o-claude-code).

---

## Sumário

1. [O problema](#1-o-problema)
2. [Por que trocar de parâmetro não resolve](#2-por-que-trocar-de-parâmetro-não-resolve)
3. [Como o integrador resolve](#3-como-o-integrador-resolve)
4. [O que você precisa](#4-o-que-você-precisa)
5. [Passo a passo](#5-passo-a-passo)
6. [Como saber se está funcionando](#6-como-saber-se-está-funcionando)
7. [Voltar atrás](#7-voltar-atrás)
8. [Limites](#8-limites)
9. [Teste A/B no upsell](#teste-ab-no-upsell)
10. [Outras plataformas](#outras-plataformas)
11. [Com o Claude Code](#com-o-claude-code)
12. [Perguntas frequentes](#perguntas-frequentes)

---

## 1. O problema

A VTurb sabe qual vídeo vendeu porque o link do checkout leva um código, o `src`:

```
v3_8f2c9a91-…_6650f1c2a9b8e7d4c3b2a190_0
   └ sessão     └ ID do vídeo (player) que a pessoa assistia
```

- **Sessão:** quem é a pessoa (o navegador dela).
- **ID do vídeo:** em qual VSL ela estava quando comprou.

Quando a compradora assiste a VSL do front e clica em comprar, o script da VTurb coloca esse código no link do checkout, e a venda chega com o `src` certo.

**No upsell 1-click é diferente.** Ela não passa por checkout nenhum: clica em "sim, eu quero" e a plataforma cobra no mesmo cartão. Sem checkout, não tem link para o script da VTurb colocar o código. Aí acontece uma de três coisas (exemplo medido na Kiwify):

| O que a plataforma manda na venda do upsell | Onde a VTurb coloca a venda |
|---|---|
| O `src` **copiado da compra do front** | Na **VSL do front** (errado: infla o front) |
| **Nenhum** `src` | Em **nenhuma** VSL (a venda some) |
| O `src` do próprio upsell (só quando ela compra por um link, ex.: botão de PIX na página do upsell) | Na **VSL do upsell** (certo) |

Na prática, a maior parte das vendas de upsell cai nos dois primeiros casos.

## 2. Por que trocar de parâmetro não resolve

`src`, `sck` e `xcod` funcionam do mesmo jeito: o código entra no **link do checkout** e só vai junto quando a pessoa passa por esse link. **O nome muda, a lógica não.**

No 1-click não existe esse link, então qualquer parâmetro chega com o valor do front ou chega vazio. O problema não é qual parâmetro você usa, é que a compra do upsell não passa por um checkout.

## 3. Como o integrador resolve

Hoje a sua plataforma manda cada venda direto para a VTurb. Com o integrador, ela manda primeiro para ele:

```
Antes:   Plataforma ───────────────────────────────► VTurb

Depois:  Plataforma ──► Integrador ──(src corrigido)──► VTurb
                     │
                     └─ grava cada venda num banco (histórico e reenvio)
```

Para cada venda, o integrador olha de qual oferta ela é (na Kiwify, pelo `checkout_link`, o ID do checkout):

| Situação | O que o integrador faz | Nome no banco (`regra`) |
|---|---|---|
| Não é upsell nem downsell (front, outros produtos) | Repassa como veio | `fora_do_funil` |
| Upsell que **já veio** com o vídeo do upsell | Repassa como veio | `ja_no_upsell` |
| Upsell com o `src` **herdado do front** | Mantém a sessão e **troca o vídeo** pelo do upsell | `trocado_player` |
| Upsell **sem** `src` | Busca a sessão na compra do front do **mesmo e-mail** (últimas 24h) e monta o `src` com o vídeo do upsell | `sessao_por_email` |
| Upsell sem `src` e sem compra anterior | Repassa sem `src` (igual a antes) | `sem_sessao` |

Por que funciona: a **sessão é a mesma** em todas as páginas do seu domínio, no mesmo navegador. Quem assistiu a VSL do upsell tem a mesma sessão da compra do front. O integrador só troca o "qual vídeo".

E mais:
- **Nada se perde:** a venda é gravada antes de qualquer envio. Se a VTurb estiver fora, o integrador tenta de novo a cada 5 minutos (até 6 vezes).
- **Sem contar em dobro:** a plataforma às vezes reenvia o mesmo evento; o banco só aceita uma vez cada pedido + evento.
- **Reembolso e chargeback** passam pelo mesmo caminho, então o reembolso do upsell também cai na VSL certa.

## 4. O que você precisa

- Uma plataforma de vendas com upsell (ou downsell) 1-click e **webhook de vendas**. O passo a passo abaixo usa a **Kiwify**; para outras, veja [Outras plataformas](#outras-plataformas).
- **VTurb** com a integração de conversões da sua plataforma (o webhook que a VTurb te dá).
- **Front e upsell no mesmo domínio** (ex.: `seusite.com/vsl` e `seusite.com/upsell`). É o cenário testado. A VTurb guarda a sessão separada por domínio, inclusive subdomínio (`www.seusite.com` e `seusite.com` contam como diferentes). Com front e upsell em domínios diferentes, a sessão da compra não é a que assistiu a VSL do upsell e a atribuição pode não funcionar: teste com uma venda antes de desligar o webhook antigo.
- Uma conta grátis no **[Supabase](https://supabase.com)**, onde o integrador roda (função + banco). O plano gratuito aguenta com folga.
- O **[Supabase CLI](https://supabase.com/docs/guides/cli)** para publicar a função (ou o Claude Code fazendo por você).

## 5. Passo a passo

> O passo a passo usa a **Kiwify**. Em outra plataforma os passos são os mesmos, mudando onde achar cada dado e o formato do webhook.

### Passo 1: anote os dados

Você vai precisar de:

| Dado | Onde achar |
|---|---|
| **Token da VTurb** | VTurb → Configurações → Rastreamento de conversões → Kiwify. Na URL do webhook (`https://tracker.vturb.com/conversions/kiwify?t=XXXX`), é o valor depois de `t=`. |
| **checkout_link de cada upsell/downsell** | Kiwify → seu produto → aba do upsell 1-click: é o ID do checkout (aparece no código do botão 1-click e no link do checkout, ex.: `pay.kiwify.com.br/AbC12dE` → `AbC12dE`). |
| **ID do vídeo (player) de cada upsell** | No código de incorporação da VTurb na página do upsell: `<vturb-smartplayer id="vid-6650f1c2a9b8e7d4c3b2a190">` → o ID é o que vem depois de `vid-` (24 caracteres). |

### Passo 2: crie o banco

1. Crie um projeto no Supabase.
2. Abra **SQL Editor**, cole o conteúdo de [`skills/vturb-upsell-tracking/assets/exemplo/supabase/migrations/001_integrador_vturb.sql`](skills/vturb-upsell-tracking/assets/exemplo/supabase/migrations/001_integrador_vturb.sql) e clique em **Run**.

Isso cria a tabela `integrador_vturb`, onde cada venda fica registrada com o que o integrador fez.

### Passo 3: publique a função

```bash
git clone https://github.com/moisajps/vturb-upsell-tracking.git
cd vturb-upsell-tracking/skills/vturb-upsell-tracking/assets/exemplo
supabase login
supabase link --project-ref SEU-PROJETO
supabase functions deploy integrador-vturb --no-verify-jwt
```

O `--no-verify-jwt` é necessário porque quem chama a função é a Kiwify, que não tem login no seu Supabase. A segurança fica por conta da assinatura do webhook (passo 5).

A URL da função fica assim:

```
https://SEU-PROJETO.supabase.co/functions/v1/integrador-vturb
```

### Passo 4: configure os segredos

Supabase → **Edge Functions → Secrets** (ou `supabase secrets set …`):

| Nome | Valor |
|---|---|
| `VTURB_KIWIFY_TOKEN` | o token da VTurb (passo 1) |
| `INTEGRADOR_DESTINOS` | o mapa de cada oferta para o vídeo dela (abaixo) |
| `INTEGRADOR_CRON_SECRET` | uma senha qualquer, longa (ex.: gere com `openssl rand -hex 32`) |
| `KIWIFY_WEBHOOK_TOKEN` | vem no passo 5 |

O `INTEGRADOR_DESTINOS` é um JSON com uma linha por oferta de upsell/downsell:

```json
{
  "ID-DO-CHECKOUT-DO-UPSELL":   { "tipo": "upsell",   "player": "ID-DO-VIDEO-DO-UPSELL" },
  "ID-DO-CHECKOUT-DO-DOWNSELL": { "tipo": "downsell", "player": "ID-DO-VIDEO-DO-DOWNSELL" }
}
```

> **Downsell sem VSL própria?** Use o vídeo do upsell da mesma etapa: foi ele que a pessoa assistiu antes de recusar e cair no downsell.

### Passo 5: crie o webhook novo na Kiwify

Kiwify → **Apps → Webhooks → Criar webhook**:

- **URL:** a da sua função (passo 3)
- **Produtos:** todos os produtos do funil (ou "Todos que sou produtor")
- **Eventos:** os mesmos que o webhook da VTurb tem hoje (confira lá antes; no mínimo "Compra aprovada")

Copie o **token** que a Kiwify mostra e salve como `KIWIFY_WEBHOOK_TOKEN` nos segredos (passo 4).

### Passo 6: teste

1. No webhook novo da Kiwify, clique em **Testar**.
2. No Supabase, abra **Table Editor → integrador_vturb**: deve aparecer uma linha.

Se nada aparecer, veja os logs em **Edge Functions → integrador-vturb → Logs**. Resposta `401` = o token da Kiwify não bate com o `KIWIFY_WEBHOOK_TOKEN`.

O teste vai para a VTurb como um pedido fictício sem vídeo: não mexe nas suas VSLs.

### Passo 7: ligue o reenvio automático

No **SQL Editor**, rode [`skills/vturb-upsell-tracking/assets/exemplo/supabase/migrations/002_agendamento.sql`](skills/vturb-upsell-tracking/assets/exemplo/supabase/migrations/002_agendamento.sql), trocando `SEU-PROJETO` e `SEU-SEGREDO` (o mesmo `INTEGRADOR_CRON_SECRET`).

### Passo 8: troque os webhooks

1. Deixe **os dois** webhooks ligados (o antigo direto para a VTurb e o novo do integrador) até passar a primeira venda real pelo integrador com `status = enviado`. A VTurb ignora um pedido que ela já recebeu, então não conta em dobro.
2. **Desligue o webhook antigo** da Kiwify para a VTurb (o que aponta para `tracker.vturb.com/conversions/kiwify`).

> Enquanto os dois estão ligados, uma venda de upsell ainda pode cair errado se o webhook antigo chegar primeiro. Por isso, não demore para desligar o antigo.

## 6. Como saber se está funcionando

No **SQL Editor**:

```sql
-- Últimas vendas e o que o integrador fez com cada uma
select recebido_em, order_ref, evento, produto, tipo, regra, status, resposta_http, ultimo_erro
from integrador_vturb order by recebido_em desc limit 50;

-- O que ainda não chegou na VTurb
select order_ref, evento, tentativas, resposta_http, ultimo_erro
from integrador_vturb where status <> 'enviado' order by recebido_em;

-- Upsells dos últimos 7 dias, por regra
select regra, count(*), sum(valor_cobrado)
from integrador_vturb
where tipo in ('upsell', 'downsell') and evento = 'order_approved'
  and recebido_em > now() - interval '7 days'
group by 1 order by 2 desc;
```

Na primeira venda de upsell depois de desligar o webhook antigo, confira:
- a linha tem `regra = trocado_player` ou `sessao_por_email`;
- na VTurb, a conversão aparece na **VSL do upsell**;
- uma venda de front continua aparecendo normalmente na VSL do front (`regra = fora_do_funil`).

## 7. Voltar atrás

Religue o webhook antigo Kiwify → VTurb e desligue o do integrador. Tudo volta a ser como era. As vendas que passaram pelo integrador continuam gravadas na tabela.

## 8. Limites

- **Vendas antigas não mudam.** A VTurb guarda o primeiro envio de cada pedido; as vendas de antes do integrador continuam onde estão.
- **Outro aparelho ou aba anônima:** se a pessoa comprou o front num aparelho e o upsell em outro, a sessão não bate e a venda segue sem atribuição, como antes.
- **Teste A/B na página do upsell:** com mais de um vídeo no mesmo player, o integrador precisa saber **qual variante** a pessoa viu. Para isso, a página do upsell precisa de um script pequeno que anota o vídeo carregado. Veja [Teste A/B no upsell](#teste-ab-no-upsell).
- **Outras plataformas:** o código pronto é para a Kiwify. Em outra plataforma, a lógica é a mesma, mas o formato do webhook muda; teste com uma venda antes de desligar o webhook antigo.

---

## Teste A/B no upsell

Se a página do upsell tem teste A/B na VTurb, o integrador precisa saber qual das versões a pessoa assistiu. Isso pede um script na página do upsell, e o jeito de colocar o script muda conforme onde o seu site é feito.

**Se o seu site está no WordPress (com ou sem Elementor), Webflow, Wix, Lovable, num construtor de páginas da sua plataforma de vendas ou em qualquer outro lugar, é só informar ao Claude.** Com a skill instalada, peça:

> *"tenho teste A/B na página do upsell, e meu site é feito no [Elementor / Webflow / …]. Me ajuda a montar."*

Ele te mostra onde colar o script na sua plataforma, cria a parte que recebe o registro e liga tudo ao integrador.

---

## Outras plataformas

O problema acontece em qualquer plataforma com upsell 1-click, porque em nenhuma delas a compra do upsell passa por um link de checkout. A correção é a mesma: receber a venda antes da VTurb, trocar o vídeo no código de rastreio mantendo a sessão, e repassar.

O que muda de uma plataforma para outra:

- **O formato do webhook:** onde vêm o e-mail, o identificador da oferta e o código de rastreio (`src`, `sck`, `xcod`…).
- **A assinatura:** como a plataforma prova que o webhook é dela.
- **O endereço da VTurb:** a VTurb tem um endereço de conversões para cada plataforma; use o mesmo que ela te deu.

Com o Claude Code e a skill instalada, peça: *"monta o integrador da VTurb para o meu upsell na [sua plataforma]"*. Ele adapta o código ao webhook da sua plataforma e te guia no teste.

---

## Com o Claude Code

Instale a skill:

```bash
npx skills add moisajps/vturb-upsell-tracking
```

E peça, por exemplo:

- *"monta o integrador da VTurb para o meu upsell da Kiwify"* (ou da sua plataforma)
- *"meu site é Next.js na Vercel, monta o integrador como rota do site"*
- *"tenho teste A/B na página do upsell e meu site é no Elementor, me ajuda a montar"*

O Claude vai perguntar os dados do passo 1, montar o integrador na sua estrutura (Supabase, Next.js ou outra), e te guiar no teste e na troca dos webhooks.

---

## Perguntas frequentes

**Preciso saber programar?**
Não para seguir o passo a passo: é copiar e colar. Com o Claude Code, ele faz a parte técnica.

**Meu site é no WordPress/Elementor. Muda alguma coisa?**
Para upsell com um vídeo só, não: o integrador roda fora do site, e você só troca o webhook. Para teste A/B no upsell, sim: veja [Teste A/B no upsell](#teste-ab-no-upsell).

**Quanto custa?**
O plano gratuito do Supabase cobre com folga (uma chamada por venda).

**Funciona na Hotmart, Eduzz ou outra plataforma?**
A lógica sim. O código pronto é da Kiwify; para outra plataforma, veja [Outras plataformas](#outras-plataformas).

**E se eu usar `sck` ou `xcod` em vez de `src`?**
Não muda nada no upsell 1-click: veja a [seção 2](#2-por-que-trocar-de-parâmetro-não-resolve).

**O integrador mexe no valor da venda?**
Não. O pedido vai para a VTurb exatamente como a Kiwify mandou, só com o `src` corrigido.

**Tenho mais de um funil.**
Coloque todas as ofertas de upsell/downsell no `INTEGRADOR_DESTINOS`. O que não estiver lá passa direto.

---

Feito por [Moisa](https://github.com/moisajps). Se ajudou, deixa uma ⭐.
