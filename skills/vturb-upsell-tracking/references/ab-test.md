# Teste A/B na página do upsell

Quando a página do upsell usa um teste A/B da VTurb (embed `ab-…` em vez de `vid-…`), o player sorteia uma variante por visitante. O integrador não pode adivinhar qual vídeo a pessoa viu: precisa de um registro.

## Desenho

1. **Registrar o que foi visto.** Um script na página do upsell, no evento de player pronto da VTurb, grava numa tabela (`vturb_vistos`):
   - a variante (ID do vídeo carregado),
   - a sessão da VTurb,
   - a página,
   - um identificador da compra do front, quando a URL tiver (a Kiwify manda o pedido/token do funil na URL da página de upsell).
2. **Na venda do upsell**, o integrador liga: e-mail → pedido(s) do front nas últimas 24h → vistos com esses identificadores ou com a sessão → variante vista **na página daquela oferta**, até 60 s depois da hora da venda.
3. Monta `v3_{sessão}_{variante}_0` com a variante encontrada (`regra = visto_na_jornada`).
4. **Sem registro, vai sem `src`** (`ab_sem_variante`). Nunca escolha uma variante "provável": isso contamina o teste.

## Cuidados

- Valide as variantes contra a lista do teste (os vídeos do `player.js` do A/B). Um vídeo fora da lista não conta.
- A decisão é gravada antes do envio e reusada nas tentativas.
- Se a consulta falhar, tente de novo pelo reenvio; só na última tentativa siga sem ela.
- Não grave dados pessoais desnecessários no registro do visto (um hash do token do funil é suficiente).
- Ao trocar o teste A/B, atualize a lista de variantes.

Implemente só se o usuário confirmar que tem teste A/B no upsell. Para vídeo único, as regras de `regras.md` bastam.
