# Teste A/B na página do upsell

Quando a página do upsell usa um teste A/B da VTurb (embed `ab-…` em vez de `vid-…`), o player sorteia uma variante por visitante. O integrador não pode adivinhar qual vídeo a pessoa viu: a página precisa **anotar** a variante, e o integrador consulta essa anotação na hora da venda.

São 4 peças:

1. **Script na página do upsell**: quando o player carrega, envia "esta sessão viu esta variante nesta página".
2. **Função de registro** (Edge Function `registrar-visto`): recebe o envio do navegador e grava.
3. **Tabela `vturb_vistos`**.
4. **Busca no integrador**: na venda do upsell, acha a variante que aquela compradora viu.

Implemente só se o usuário confirmar que tem teste A/B no upsell. Para vídeo único, nada disto é necessário.

## Primeiro: pergunte onde a página do upsell é feita

A peça 1 depende de onde o site está. Pergunte e oriente o usuário pelo caminho certo:

| Onde está a página | Onde colar o script |
|---|---|
| **WordPress + Elementor** | Widget **HTML** do Elementor na página do upsell (arraste para qualquer seção; não aparece na tela). Alternativa: plugin **WPCode** → "Adicionar snippet" → JavaScript → carregar só na página do upsell. |
| **WordPress sem Elementor** | Plugin **WPCode** (rodapé, só na página do upsell) ou bloco "HTML personalizado" do editor. |
| **Webflow** | Configurações da página do upsell → **Custom code → Before `</body>` tag**. |
| **Wix** | Configurações → **Código personalizado** → adicionar no fim do corpo, só na página do upsell. |
| **Construtores de página das plataformas** (Hotmart Pages, Greatpages, etc.) | Campo de script/código personalizado da página, se existir. Se o construtor não aceita script, o teste A/B não tem como ser atribuído: avise o usuário. |
| **Lovable, Next.js, React** | Componente no próprio código (o mesmo script, dentro de um `useEffect`). |
| **HTML puro** | `<script>` antes de `</body>`. |

Sempre: o script vai **só na página do upsell** (e do downsell, se tiver vídeo com A/B), **depois** do embed da VTurb ou no rodapé.

Antes de colar, confirme na prática que a página recebe da plataforma de vendas os parâmetros que ligam a compra do front ao upsell (veja "A jornada da compra" abaixo). Peça ao usuário para fazer uma compra de teste e copiar a URL da página do upsell (sem dados pessoais).

## Peça 1: script (modelo em JavaScript puro)

Troque `URL_DA_FUNCAO` e a lista `VARIANTES` (os IDs dos vídeos do teste A/B, 24 caracteres cada; aparecem no `player.js` do teste na VTurb).

```html
<script>
(function () {
  var URL_DA_FUNCAO = "https://SEU-PROJETO.supabase.co/functions/v1/registrar-visto";
  var VARIANTES = ["ID_DO_VIDEO_A", "ID_DO_VIDEO_B"];
  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // Onde a VTurb guarda a sessão no navegador (a chave nova primeiro).
  var CHAVES = ["__storejs_hermes-session_hermes_session_id", "hermes_session_id"];
  var feito = false;

  function lerSessao(soNova) {
    try {
      var lista = soNova ? CHAVES.slice(0, 1) : CHAVES;
      for (var i = 0; i < lista.length; i++) {
        var m = (localStorage.getItem(lista[i]) || "").match(UUID);
        if (m) return m[0].toLowerCase();
      }
    } catch (e) {}
    return null;
  }

  // A VTurb pode gravar a sessão alguns segundos depois do player carregar.
  function esperarSessao(cb, tentativa) {
    tentativa = tentativa || 0;
    var s = lerSessao(tentativa < 5);
    if (s || tentativa >= 10) return cb(s);
    setTimeout(function () { esperarSessao(cb, tentativa + 1); }, 1000);
  }

  // Kiwify: order_code (pedido do front) e token (do 1-click) vêm na URL do upsell.
  // O token é credencial: só o hash SHA-256 sai do navegador.
  function jornada(cb) {
    var p = new URLSearchParams(location.search);
    var order = p.get("order_code");
    var token = p.get("token");
    var dados = { order_code: order && /^[A-Za-z0-9]{5,12}$/.test(order) ? order : null, token_hash: null };
    if (!token || !window.crypto || !crypto.subtle) return cb(dados);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then(function (buf) {
      dados.token_hash = Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      cb(dados);
    }, function () { cb(dados); });
  }

  document.addEventListener("player:ready", function (ev) {
    if (feito) return;
    var player = String((ev.detail && ev.detail.config && ev.detail.config.id) || "").toLowerCase();
    if (!player || VARIANTES.map(function (v) { return v.toLowerCase(); }).indexOf(player) < 0) return;
    feito = true;
    esperarSessao(function (sessao) {
      if (!sessao) return;
      jornada(function (j) {
        fetch(URL_DA_FUNCAO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessao: sessao, player: player, pagina: location.pathname, order_code: j.order_code, token_hash: j.token_hash }),
          keepalive: true
        });
      });
    });
  });
})();
</script>
```

Adaptações por plataforma de vendas: os nomes `order_code` e `token` são da Kiwify. Em outra plataforma, descubra na URL real da página do upsell (compra de teste) qual parâmetro identifica a compra do front e qual segue igual pelo funil; ajuste o script e a busca.

## Peça 2: função `registrar-visto`

Edge Function pública (`--no-verify-jwt`), chamada pelo navegador de **outro domínio**, então:

- Responda `OPTIONS` com CORS (`Access-Control-Allow-Origin` = o domínio do site do usuário; `Allow-Headers: content-type`; `Allow-Methods: POST, OPTIONS`) e inclua o mesmo `Allow-Origin` na resposta do `POST`.
- Valide tudo antes de gravar (o endereço é público): `sessao` UUID, `player` 24 hex, `order_code` `^[A-Za-z0-9]{5,12}$` ou null, `token_hash` 64 hex ou null, `pagina` normalizada (minúscula, sem query, com barra no começo e no fim, até 80 caracteres). Formato inválido → 400.
- Grave com a service role. Banco fora → 503.
- Não grave IP, e-mail nem o token em si.

## Peça 3: tabela

```sql
create table if not exists public.vturb_vistos (
  id         bigint generated always as identity primary key,
  sessao     text not null check (sessao ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  player     text not null check (player ~ '^[0-9a-f]{24}$'),
  pagina     text check (char_length(pagina) <= 80),
  order_code text check (order_code ~ '^[A-Za-z0-9]{5,12}$'),
  token_hash text check (token_hash ~ '^[0-9a-f]{64}$'),
  visto_em   timestamptz not null default now()
);
alter table public.vturb_vistos enable row level security;
create index if not exists vturb_vistos_order_code_idx on public.vturb_vistos (order_code) where order_code is not null;
create index if not exists vturb_vistos_token_pagina_idx on public.vturb_vistos (token_hash, pagina, visto_em desc) where token_hash is not null;
create index if not exists vturb_vistos_sessao_pagina_idx on public.vturb_vistos (sessao, pagina, visto_em desc);
```

## Peça 4: a jornada da compra (busca no integrador)

No `INTEGRADOR_DESTINOS`, a oferta com A/B ganha a página do vídeo e as variantes em vez de um `player` único:

```json
{ "CHECKOUT_DO_UPSELL": { "tipo": "upsell", "pagina": "/upsell/", "variantes": ["ID_DO_VIDEO_A", "ID_DO_VIDEO_B"] } }
```

Na venda dessa oferta, com `quando` = hora da venda:

1. Se o `src` recebido já tem uma das variantes → `ja_no_upsell`, repassa.
2. Pedidos aprovados do **mesmo e-mail** entre `quando − 24h` e `quando + 60s` (tabela do integrador) → seus `order_ref` (o pedido do front) e as sessões do `src` deles.
3. Vistos com `order_code` nesses pedidos → seus `token_hash` e sessões.
4. Último visto **na página da oferta**, com `player` entre as variantes, `token_hash` ou `sessao` entre os encontrados, entre `quando − 24h` e `quando + 60s`.
5. Achou → `src = v3_{sessão do visto}_{player do visto}_0`, `regra = visto_na_jornada`.
6. Não achou → **sem `src`**, `regra = ab_sem_variante`. Nunca escolha uma variante "provável": contamina o teste.

Se a busca der erro, deixe a venda para o reenvio; só na última tentativa siga sem ela (`ab_sem_variante`) para não perder a venda. A decisão é gravada antes do envio e reusada nas tentativas.

O `+60s` existe porque a Kiwify manda a hora da venda sem segundos.

## Como testar

1. Abra a página do upsell, deixe o player carregar e confira uma linha nova em `vturb_vistos` (a variante que caiu para você).
2. Faça uma compra de teste do front + upsell e confira, na tabela do integrador, `regra = visto_na_jornada` com o vídeo da linha anterior.
3. Ao trocar o teste A/B na VTurb, atualize `VARIANTES` no script e `variantes` no `INTEGRADOR_DESTINOS`.
