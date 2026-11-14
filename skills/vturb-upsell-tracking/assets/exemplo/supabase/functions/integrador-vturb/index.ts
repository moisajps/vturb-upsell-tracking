/**
 * Integrador Kiwify → VTurb (Supabase Edge Function).
 *
 * Problema: a VTurb decide em qual VSL a venda cai pelo ID do player que vem
 * dentro do `src` (v3_{sessão}_{player}_…). No upsell 1-click a compra não passa
 * por um checkout novo: a Kiwify copia o src da compra do front (a venda cai na
 * VSL do front) ou manda sem src (a venda não cai em VSL nenhuma).
 *
 * Solução: a Kiwify manda o webhook para cá em vez de mandar direto para a VTurb.
 * Aqui a venda é gravada, o src de upsell/downsell é corrigido (mesma sessão,
 * player do upsell) e o pedido segue para a VTurb.
 *
 * Variáveis (Supabase → Edge Functions → Secrets):
 *   KIWIFY_WEBHOOK_TOKEN  token do webhook criado na Kiwify (aceita vários, separados por vírgula)
 *   VTURB_KIWIFY_TOKEN    o `t=` da URL de webhook que a VTurb te deu para a Kiwify
 *   INTEGRADOR_DESTINOS        JSON: { "<checkout_link>": { "tipo": "upsell", "player": "<id do vídeo>" } }
 *   INTEGRADOR_CRON_SECRET     segredo do agendamento que reenvia o que falhou
 * SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda Edge Function.
 *
 * Deploy: supabase functions deploy integrador-vturb --no-verify-jwt
 */

type Tipo = "upsell" | "downsell";
type Destino = { tipo: Tipo; player: string };

type Pedido = {
  order_id?: string;
  order_ref?: string;
  webhook_event_type?: string;
  checkout_link?: string | null;
  Product?: { product_name?: string };
  Customer?: { email?: string };
  Commissions?: { charge_amount?: number | string } & Record<string, unknown>;
  TrackingParameters?: { src?: string | null } & Record<string, unknown>;
} & Record<string, unknown>;

type Regra =
  | "fora_do_funil" //    não é upsell/downsell: repassa como veio
  | "ja_no_upsell" //     src já é do vídeo do upsell (ex.: link de PIX/parcelar na página do upsell)
  | "trocado_player" //   src herdado do front: troca o player, mantém a sessão
  | "sessao_por_email" // sem src: sessão tirada de uma compra anterior do mesmo e-mail
  | "sem_sessao"; //      sem src e sem compra anterior: segue sem src (como era antes)

type Decisao = { tipo: Tipo | "outro"; regra: Regra; src: string | null };

type Linha = {
  id: string;
  order_id: string;
  order_ref: string | null;
  tentativas: number;
  regra: Regra | null;
  tipo: Decisao["tipo"] | null;
  src_enviado: string | null;
  signature: string | null;
  payload: Pedido;
};

const MAX_TENTATIVAS = 6;
const env = (nome: string) => Deno.env.get(nome) ?? "";

// ---------------------------------------------------------------------------
// src da VTurb: v3_{sessão (uuid)}_{player (24 hex)}_{segundos}…
// ---------------------------------------------------------------------------

const SRC_RE = /^v3_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{24})(?:_|$)/i;

function lerSrc(src: unknown): { sessao: string; player: string } | null {
  if (typeof src !== "string") return null;
  const m = SRC_RE.exec(src.trim());
  return m ? { sessao: m[1].toLowerCase(), player: m[2].toLowerCase() } : null;
}

// Segundos vão 0: a VTurb usa os dados de visualização que ela já tem daquela sessão.
const montarSrc = (sessao: string, player: string) => `v3_${sessao}_${player}_0`;

function destinos(): Record<string, Destino> {
  try {
    return JSON.parse(env("INTEGRADOR_DESTINOS") || "{}");
  } catch {
    console.error("[integrador] INTEGRADOR_DESTINOS não é um JSON válido");
    return {};
  }
}

// ---------------------------------------------------------------------------
// Decisão do src
// ---------------------------------------------------------------------------

async function decidir(pedido: Pedido, buscarSessao: (email: string) => Promise<string | null>): Promise<Decisao> {
  const original = pedido.TrackingParameters?.src ?? null;
  const destino = destinos()[pedido.checkout_link ?? ""];
  if (!destino) return { tipo: "outro", regra: "fora_do_funil", src: original };

  const alvo = destino.player.toLowerCase();
  const lido = lerSrc(original);
  if (lido?.player === alvo) return { tipo: destino.tipo, regra: "ja_no_upsell", src: original };
  if (lido) return { tipo: destino.tipo, regra: "trocado_player", src: montarSrc(lido.sessao, alvo) };

  const email = pedido.Customer?.email?.trim().toLowerCase();
  const sessao = email ? await buscarSessao(email) : null;
  if (sessao) return { tipo: destino.tipo, regra: "sessao_por_email", src: montarSrc(sessao, alvo) };
  return { tipo: destino.tipo, regra: "sem_sessao", src: null };
}

// ---------------------------------------------------------------------------
// Assinatura da Kiwify: HMAC-SHA1 (hex) do corpo, com o token do webhook
// ---------------------------------------------------------------------------

async function hmacSha1Hex(chave: string, corpo: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(corpo));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function assinaturaValida(corpo: string, assinatura: string | null): Promise<boolean> {
  if (!assinatura) return false;
  const recebida = assinatura.toLowerCase();
  for (const token of env("KIWIFY_WEBHOOK_TOKEN").split(",").map((t) => t.trim()).filter(Boolean)) {
    if (iguais(await hmacSha1Hex(token, corpo), recebida)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Banco (PostgREST com a service role)
// ---------------------------------------------------------------------------

async function db(caminho: string, init: RequestInit = {}): Promise<Response> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(`${env("SUPABASE_URL")}/rest/v1/integrador_vturb${caminho}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
}

/** Grava a venda. Devolve a linha criada, ou null se esse (order_id, evento) já tinha chegado. */
async function gravar(pedido: Pedido, assinatura: string | null): Promise<Linha | null> {
  const src = pedido.TrackingParameters?.src ?? null;
  const centavos = Number(pedido.Commissions?.charge_amount);
  const res = await db("", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      order_id: String(pedido.order_id),
      order_ref: pedido.order_ref ?? null,
      evento: pedido.webhook_event_type ?? "desconhecido",
      email: pedido.Customer?.email?.trim().toLowerCase() ?? null,
      checkout_link: pedido.checkout_link ?? null,
      produto: pedido.Product?.product_name ?? null,
      valor_cobrado: Number.isFinite(centavos) ? centavos / 100 : null,
      src_original: src,
      sessao_vturb: lerSrc(src)?.sessao ?? null,
      signature: assinatura,
      payload: pedido,
    }),
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`insert ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as Linha[])[0];
}

/** Sessão VTurb mais recente do mesmo e-mail nas últimas 24h (o upsell vem logo depois do front). */
async function buscarSessaoPorEmail(email: string): Promise<string | null> {
  const q = new URLSearchParams({
    select: "sessao_vturb",
    email: `eq.${email}`,
    sessao_vturb: "not.is.null",
    recebido_em: `gte.${new Date(Date.now() - 864e5).toISOString()}`,
    order: "recebido_em.desc",
    limit: "1",
  });
  const res = await db(`?${q}`);
  if (!res.ok) throw new Error(`busca ${res.status}`);
  return ((await res.json()) as { sessao_vturb: string }[])[0]?.sessao_vturb ?? null;
}

async function atualizar(id: string, campos: Record<string, unknown>) {
  const res = await db(`?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(campos) });
  if (!res.ok) throw new Error(`update ${res.status}`);
}

// ---------------------------------------------------------------------------
// Envio para a VTurb (mesmo endereço do webhook que a VTurb te deu para a Kiwify)
// ---------------------------------------------------------------------------

function enviar(pedido: Pedido, assinatura: string | null, decisao: Decisao): Promise<Response> {
  const q = new URLSearchParams({ t: env("VTURB_KIWIFY_TOKEN") });
  if (assinatura) q.set("signature", assinatura);
  return fetch(`https://tracker.vturb.com/conversions/kiwify?${q}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      // O firewall do tracker recusa User-Agents de script (erro 403/1010).
      "User-Agent": "axios/1.7.7",
    },
    body: JSON.stringify({ ...pedido, TrackingParameters: { ...(pedido.TrackingParameters ?? {}), src: decisao.src } }),
    signal: AbortSignal.timeout(10000),
  });
}

async function processar(linha: Linha): Promise<void> {
  try {
    // Uma decisão já tomada é reusada: a VTurb guarda o primeiro envio de cada order_id.
    const decisao: Decisao = linha.regra
      ? { tipo: linha.tipo ?? "outro", regra: linha.regra, src: linha.src_enviado }
      : await decidir(linha.payload, buscarSessaoPorEmail);
    if (!linha.regra) await atualizar(linha.id, { tipo: decisao.tipo, regra: decisao.regra, src_enviado: decisao.src });

    const res = await enviar(linha.payload, linha.signature, decisao);
    await atualizar(linha.id, {
      tentativas: linha.tentativas + 1,
      resposta_http: res.status,
      ...(res.ok
        ? { status: "enviado", enviado_em: new Date().toISOString(), ultimo_erro: null }
        : { status: "erro", ultimo_erro: (await res.text()).slice(0, 500) }),
    });
  } catch (err) {
    console.error("[integrador]", linha.order_ref ?? linha.order_id, err);
    await atualizar(linha.id, {
      status: "erro",
      tentativas: linha.tentativas + 1,
      ultimo_erro: String(err instanceof Error ? err.message : err).slice(0, 500),
    }).catch(() => {});
  }
}

/** Reenvia o que falhou ou ficou pendente (chamado pelo agendamento a cada 5 min). */
async function reprocessar(): Promise<number> {
  const q = new URLSearchParams({
    select: "*",
    status: "neq.enviado",
    tentativas: `lt.${MAX_TENTATIVAS}`,
    recebido_em: `lt.${new Date(Date.now() - 2 * 60e3).toISOString()}`,
    order: "recebido_em.asc",
    limit: "50",
  });
  const res = await db(`?${q}`);
  if (!res.ok) throw new Error(`pendentes ${res.status}`);
  const linhas = (await res.json()) as Linha[];
  for (const linha of linhas) await processar(linha);
  return linhas.length;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Agendamento: POST ?reprocessar=1 com o header x-integrador-secret
  if (url.searchParams.has("reprocessar")) {
    if (!env("INTEGRADOR_CRON_SECRET") || req.headers.get("x-integrador-secret") !== env("INTEGRADOR_CRON_SECRET")) return json({ ok: false }, 401);
    return json({ ok: true, processadas: await reprocessar() });
  }

  if (req.method !== "POST") return json({ ok: false }, 405);
  if (!env("KIWIFY_WEBHOOK_TOKEN") || !env("VTURB_KIWIFY_TOKEN")) return json({ ok: false, erro: "configuração" }, 500);

  const corpo = await req.text();
  const assinatura = url.searchParams.get("signature");
  if (!(await assinaturaValida(corpo, assinatura))) return json({ ok: false, erro: "assinatura" }, 401);

  let bruto: { order?: Pedido } & Pedido;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    return json({ ok: false, erro: "json" }, 400);
  }
  const pedido = bruto.order ?? bruto;
  // Carrinho abandonado e afins não têm order_id: não é venda, nada a repassar.
  if (!pedido?.order_id) return json({ ok: true, ignorado: true });

  try {
    const linha = await gravar(pedido, assinatura);
    if (!linha) return json({ ok: true, duplicado: true });
    // Responde na hora para a Kiwify; o envio para a VTurb segue em segundo plano.
    // @ts-ignore EdgeRuntime existe no runtime do Supabase
    EdgeRuntime.waitUntil(processar(linha));
    return json({ ok: true });
  } catch (err) {
    console.error("[integrador] banco fora, mandando direto:", err);
    // Banco fora: manda direto (sem busca por e-mail). Se também falhar, o 503 faz a Kiwify reenviar.
    const decisao = await decidir(pedido, async () => null);
    const res = await enviar(pedido, assinatura, decisao).catch(() => null);
    return res?.ok ? json({ ok: true, semBanco: true }) : json({ ok: false, erro: "banco" }, 503);
  }
});
