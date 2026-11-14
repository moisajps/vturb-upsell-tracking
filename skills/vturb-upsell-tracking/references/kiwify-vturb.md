# Kiwify e VTurb: formatos

## Webhook da Kiwify

- `POST` com JSON. Assinatura em `?signature=`: **HMAC-SHA1 em hex do corpo bruto**, com o token do webhook como chave. Valide antes de fazer `JSON.parse` (use o texto recebido).
- Campos que o integrador usa (o resto é repassado intacto):

| Campo | Uso |
|---|---|
| `order_id` | chave do pedido (com `webhook_event_type`, chave única) |
| `order_ref` | referência legível (logs) |
| `webhook_event_type` | `order_approved`, `order_refunded`, `chargeback`… |
| `checkout_link` | ID do checkout → identifica a oferta (front, upsell, downsell) |
| `Customer.email` | busca da sessão quando falta `src` |
| `Commissions.charge_amount` | valor cobrado, em centavos |
| `TrackingParameters.src` | o código da VTurb (o que o integrador corrige) |

- Datas (`approved_date`) vêm como `"2026-10-17 19:48"`, sem fuso, em horário de Brasília.
- Ao criar o webhook na Kiwify, selecione os mesmos eventos que o webhook da VTurb já tinha.

## Tracker de conversões da VTurb

- Endpoint: `POST https://tracker.vturb.com/conversions/kiwify?t={token}&signature={signature original}`.
- O `t` é o token que a VTurb gera para a integração com a Kiwify (Configurações → Rastreamento de conversões → Kiwify).
- Corpo: o mesmo JSON da Kiwify, com `TrackingParameters.src` trocado.
- Headers: `Content-Type: application/json`, `Accept: application/json, text/plain, */*`, `User-Agent: axios/1.7.7` (o firewall recusa User-Agents de script como `Python-urllib`, com 403/erro 1010).
- **A VTurb guarda o primeiro envio de cada `order_id`** e ignora os seguintes. Por isso o webhook direto Kiwify → VTurb precisa ser desligado: se ele chegar antes do integrador, a venda fica com o `src` errado.

## O `src`

```
v3_{sessão}_{player}_{segundos}[_t-…_h-…_s-…]
```

- `sessão`: UUID do navegador (localStorage do domínio).
- `player`: 24 hex, o ID do vídeo (no embed `<vturb-smartplayer id="vid-{player}">`).
- `segundos`: pode ir `0`; a VTurb usa os dados de visualização que já tem daquela sessão.
- O integrador monta `v3_{sessão}_{player}_0`.

## `src`, `sck`, `xcod`

Todos são preenchidos pelo script da VTurb no link do checkout. Nenhum deles chega certo no 1-click, porque a compra não passa por link de checkout. Trocar de parâmetro não resolve.
