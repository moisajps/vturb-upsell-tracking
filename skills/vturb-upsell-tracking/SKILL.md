---
name: vturb-upsell-tracking
description: Monta um integrador entre a plataforma de vendas (Kiwify pronta; Hotmart, Eduzz e outras por adaptação) e a VTurb, que faz as vendas de upsell/downsell 1-click caírem na VSL certa da VTurb (em vez da VSL do front ou de nenhuma). Use quando o usuário disser que as conversões do upsell não aparecem na VSL do upsell, que a VSL do front está "inflada", que quer medir ou fazer teste A/B na VSL de upsell, ou pedir para "montar o integrador da VTurb", "corrigir o src do upsell", "integrar Kiwify com VTurb pelo webhook", "conversão do one-click buy na VTurb". Também use quando perguntarem se trocar src por sck/xcod resolve.
---

# Integrador VTurb

Faz a venda do upsell 1-click da Kiwify cair na VSL do upsell na VTurb.

## O problema (explique ao usuário em 3 frases, sem jargão)

A VTurb atribui a venda ao vídeo cujo ID vem no `src` do pedido (`v3_{sessão}_{player}_…`). No upsell 1-click não há checkout novo, então a Kiwify **copia o `src` da compra do front** (a venda cai na VSL do front) ou **manda sem `src`** (não cai em VSL nenhuma). Trocar o parâmetro (`sck`, `xcod`) não resolve: todos dependem de a pessoa passar por um link de checkout, e no 1-click ela não passa.

## A solução

Um webhook intermediário: Kiwify → **integrador** → VTurb. O integrador grava cada venda, identifica upsell/downsell pelo `checkout_link`, e corrige o `src`:

| Caso | Ação | `regra` |
|---|---|---|
| `checkout_link` fora do mapa | repassa como veio | `fora_do_funil` |
| `src` já tem o player do upsell | repassa | `ja_no_upsell` |
| `src` com outro player (herdado do front) | `v3_{mesma sessão}_{player do upsell}_0` | `trocado_player` |
| sem `src` | busca a sessão da compra anterior do mesmo e-mail (24h) e monta o src | `sessao_por_email` |
| sem `src` e sem compra anterior | segue sem `src` | `sem_sessao` |

Detalhes, formato do webhook e casos de borda: `references/regras.md`, `references/kiwify-vturb.md`.

## Fluxo de trabalho

### 1. Entender o projeto do usuário (antes de escrever código)

Pergunte só o que não der para descobrir lendo o projeto:

- **Onde o integrador vai rodar?** Procure no projeto: `next.config.*` + Vercel → rota do Next.js; `supabase/` → Edge Function; nada disso → recomende **Supabase Edge Function** (grátis, banco e função juntos).
- **Ofertas:** quais upsells/downsells 1-click existem, o `checkout_link` de cada um e o **ID do player** (24 hex, depois de `vid-` no embed `<vturb-smartplayer id="vid-…">`). Se o projeto tiver as páginas, extraia o player do código.
- **Downsell sem VSL própria:** usa o player do upsell da mesma etapa (foi o vídeo que a pessoa viu).
- **Teste A/B na página do upsell?** (embed com `ab-…` em vez de `vid-…`). Se sim, leia `references/ab-test.md` antes de tudo: exige um script na página do upsell. **Pergunte onde a página do upsell é feita** (WordPress/Elementor, Webflow, Wix, construtor da plataforma, Lovable, Next.js, HTML) e oriente o usuário passo a passo, clique a clique, para colar o script naquela plataforma. Para upsell com um vídeo só, a plataforma do site não importa: o integrador roda fora dele.
- **Front e upsell no mesmo domínio?** Se não, avise: a sessão da VTurb é separada por domínio (subdomínio e `www` contam como diferentes), o cenário entre domínios nunca foi testado e a atribuição pode não funcionar. Peça para validar com uma venda real antes de desligar o webhook antigo.

### 2. Implementar

- **Supabase:** copie `assets/exemplo/supabase/` desta skill para o projeto: migration `001_integrador_vturb.sql`, função `integrador-vturb`, e `002_agendamento.sql` (reenvio a cada 5 min via pg_cron + pg_net). Deploy com `--no-verify-jwt`.
- **Next.js/Vercel:** porte a mesma lógica para `app/api/kiwify/webhook/route.ts` (responde 200 e processa com `after()`), um cron em `vercel.json` (`*/5 * * * *`) chamando uma rota de reprocessamento protegida por `CRON_SECRET`, e a tabela via migration. Atenção a `trailingSlash`: se o site usa, a URL do webhook precisa da barra no final (senão 308 e a Kiwify não segue).
- **Outra stack:** mantenha os invariantes abaixo; a forma é livre.

**Invariantes (não negocie):**
1. Valide a assinatura da Kiwify: HMAC-SHA1 hex do **corpo bruto** com o token do webhook, comparado com `?signature=`. Aceite vários tokens separados por vírgula.
2. **Grave antes de enviar**, com `unique (order_id, evento)`. Reenvio da Kiwify vira duplicado, não reprocessa.
3. **Responda 200 rápido** e envie para a VTurb em segundo plano. Se o banco falhar, mande direto (sem busca por e-mail) e, se isso falhar, responda 5xx para a Kiwify reenviar.
4. **A decisão de um pedido é tomada uma vez** e reusada nas novas tentativas: a VTurb guarda o primeiro envio de cada `order_id` e ignora os seguintes.
5. Envie para `https://tracker.vturb.com/conversions/kiwify?t={token}` repassando o `signature` original, o corpo intacto (só `TrackingParameters.src` trocado) e `User-Agent: axios/1.7.7` (o firewall recusa User-Agent de script com 403).
6. Segundos no `src` vão `0`.
7. Nunca invente variante de teste A/B: sem dado da variante, vá sem `src`.

### 3. Ligar (guie o usuário, passo a passo)

1. Secrets: `KIWIFY_WEBHOOK_TOKEN`, `VTURB_KIWIFY_TOKEN` (o `t=` da URL do webhook que a VTurb deu para a Kiwify), `INTEGRADOR_DESTINOS` (JSON `checkout_link → {tipo, player}`), `INTEGRADOR_CRON_SECRET`.
2. Na Kiwify, **webhook novo** apontando para o integrador, com os mesmos eventos do webhook atual da VTurb. Copiar o token → secret.
3. Botão **Testar** da Kiwify → conferir a linha na tabela `integrador_vturb`. `401` = token não bate.
4. Manter os dois webhooks até a primeira venda real com `status = enviado`; então **desligar o webhook antigo** Kiwify → VTurb.
5. Conferir na primeira venda de upsell: `regra` = `trocado_player` ou `sessao_por_email`, e a conversão na VSL do upsell na VTurb.

Consultas de acompanhamento: `references/regras.md#acompanhamento`.

### 4. Nunca

- Nunca peça para o usuário colar tokens no chat; oriente a salvar direto nos secrets.
- Nunca desligue o webhook antigo antes de ver uma venda real passar pelo integrador.
- Nunca prometa corrigir vendas antigas: a VTurb ignora `order_id` repetido.
- Não afirme que outra plataforma (Hotmart, Eduzz…) se comporta igual sem testar; o formato do webhook muda.

## Outra plataforma (não Kiwify)

A lógica é a mesma; adapte três pontos, confirmando cada um na documentação da plataforma ou num webhook de teste real (peça ao usuário para disparar um e mostrar o corpo, sem tokens):
1. **Campos do webhook:** identificador da oferta (o que distingue front, upsell e downsell), e-mail, código de rastreio (`src`, `sck` ou `xcod`) e o evento.
2. **Validação da assinatura** do webhook da plataforma.
3. **Endereço de conversões da VTurb** para essa plataforma: use o mesmo que a VTurb deu ao usuário e repasse o corpo no formato que a VTurb já recebia.
Teste com uma venda real antes de desligar o webhook antigo.
