# QA: rotas administrativas Biano CONECTAR/EXCLUIR e clientes (healthcare, delivery)

Data: 2026-11-25. Nenhum codigo de producao alterado. Sem commit/push.

## Parecer

- Biano (api_biano): REPROVADO. 1 Critico, 2 Altos abertos.
- caristeo-healthcare (cliente): APROVADO COM RESSALVAS (nenhum Critico/Alto proprio; depende da correcao do Biano; 1 Medio).
- delivery-caristeo (cliente): APROVADO COM RESSALVAS (idem).

Motivo da reprovacao do Biano: o requisito do dono ("NAO podem afetar o fluxo interno") e violavel por uma chamada assinada valida (QA-C1).

## Comandos executados

| Comando | Resultado |
|---|---|
| Biano `npm test` | 59 testes, 59 pass, 0 fail |
| Biano `npx tsc --noEmit` | exit 0, sem erros |
| Biano `npx tsx --test src/routes/webhook-routes-admin.qa.test.ts` (novo, QA) | 50 testes: 47 pass, 2 todo (defeitos QA-C1 e QA-A2 reproduzidos), 1 "cancelled" (handle aberto do arquivo, so atraso de 8 s; nao e falha de logica) |
| healthcare `node tests/unit/run-wa-pure.mjs` (inclui wa-biano-route.test.mjs; rodar o .mjs direto falha por exigir WA_TMP) | 153 pass, 0 fail |
| healthcare `tsc --noEmit -p tsconfig.app.json` | exit 0 |
| healthcare `eslint src/components/settings/WhatsAppTab.tsx` | sem erros |
| delivery `node --test scripts/audit/whatsapp-*.test.mjs` | 221 testes, 220 pass, 1 fail: `whatsapp-instance-handler` (pre-existente, conhecido) |
| delivery `tsc --noEmit -p tsconfig.app.json` | unico erro: `jsqr` (pre-existente) |
| delivery `eslint WhatsAppMetaChannelCard.tsx` | sem erros |
| PostgreSQL 16 descartavel (docker `postgres:16`, container `qa-pg16`, removido ao fim) | 3 migrations aplicadas 2x cada: reexecutaveis (so NOTICE "already exists, skipping"); CHECK de `routing_status` rejeita valor invalido; UPDATE proposto abaixo funciona |

Nao verificado: execucao contra o Prisma real/banco real do Biano (`prisma generate`, `db pull`); Edge Runtime Deno de healthcare/delivery (`bianoRoute.ts` fica fora do tsc do app; coberto so pelo teste .mjs); producao; se o Biano roda atras de proxy reverso.

## Matriz de criterios

| Criterio | Verificacao | Resultado |
|---|---|---|
| 1. Assinatura adulterada / corpo alterado / segredo errado | teste existente + QA | Passou (401) |
| 1. HMAC cobre bytes exatos (espacos, ordem de chaves, unicode escapado, byte extra) | QA, 4 variantes re-serializadas | Passou (401); bytes originais UTF-8 ok |
| 1. Replay: dentro de 300 s ok, 301 s nao; futuro +300 ok, +301 nao | QA unitario | Passou |
| 1. Timestamp em ms, negativo, decimal, hex, expoente, espaco, vazio | QA | Passou (rejeitados; regex `^\d{1,12}$`) |
| 1. Cabecalhos duplicados (assinatura ou timestamp) | QA com http.request cru | Passou (Node junta com ", " e a comparacao falha: 401) |
| 1. Comparacao em tempo constante | leitura: `timingSafeEqual` apos checar tamanho (linha 73-74) | Passou |
| 1. Sem secret / sem hosts => 503 | teste existente; leitura (linhas 154, 168) | Passou. Obs: sem secret o 503 vem antes de qualquer validacao |
| 1. Tamanho minimo do segredo | QA: segredo de 1 char aceito | FALHOU (QA-B2, Baixo) |
| 1. Corpo 4096 / 4097 bytes | QA | Passou (4096 ok, 4097 => 413) |
| 1. id da URL != id do corpo no disconnect | QA | Passou (400) |
| 2. userinfo, porta, query, fragmento, IPv4/IPv6, decimal/octal/hex, localhost, 169.254.169.254, metadata | QA, 28 vetores | Passou (todos rejeitados) |
| 2. evil-supabase.co, supabase.co.evil.com, supabase.co puro, ponto inicial/final, punycode, homografo | QA | Passou |
| 2. path errado, barra final, maiuscula, %2f, dot-segments, `\@`, http, `//` | QA | Passou. URL gravada e reconstruida (`https://${host}/functions/v1/whatsapp`), nao a string do cliente |
| 2. Wildcard `*.supabase.co` | QA | Aceita QUALQUER projeto Supabase e subdominios multinivel: QA-A1 |
| 2. Redirecionamento no repasse existente (meta-proxy.ts) | QA com servidores locais | Segue 302 como GET com cabecalhos `x-wa-proxy-*`/`x-hub-signature-256` (QA-M1). 307/308 com corpo falha no Node 22 (undici, ArrayBuffer detached), nao segue |
| 3. Conflito de source => 409; disconnect de outro source => 409 | testes existente + QA | Passou |
| 3. Linha sem source nunca alterada (connect e disconnect) | QA | Passou (409, nada muda) |
| 3. Legado 556634016000 como phoneNumberId ou displayPhone => 403 | QA | Passou so para esses dois valores. Contornavel: QA-C1 |
| 3. Reconexao de soft delete por outro source | QA | Funciona como decidido; risco em QA-M3 |
| 3. Exclusao so do mesmo source | QA | Passou, mas `source` e autodeclarado com segredo unico: QA-A3 |
| 3. Corrida de duas conexoes do mesmo numero | QA (store com latencia entre find e upsert) | FALHOU (QA-A2): ambas 200, a ultima sobrescreve o dono |
| 4. `POST /webhook/meta` e `meta-proxy.ts` nao mudaram | `git diff` (working tree vs HEAD) | NAO identicos: ha alteracoes. Ver secao Isolamento |
| 4. Linhas sem source continuam roteando como antes | leitura + teste existente | Passou (comportamento equivalente) |
| 5. Migracao Biano reexecutavel | PG16 2x | Passou |
| 5. Linha healthcare 1278785958662616 sem source | analise + PG | Recebera 409 ate o UPDATE (ver Migracao) |
| 6. Assinatura dos clientes igual a do Biano (`${ts}.${corpo}`, cabecalhos `X-Route-Timestamp`/`X-Route-Signature`, hex) | leitura dos 2 clientes + teste healthcare recalcula com createHmac | Passou |
| 6. `BIANO_ROUTE_MODE` exato `live` | leitura (`!== 'live'` => stub) | Passou |
| 6. Timeout 8 s, `redirect: "manual"` | leitura | Passou |
| 6. Falha do Biano nao apaga conexao; vira `routing_status` | leitura + testes | Passou |
| 6. Resync; `pending_delete` na desconexao | leitura + testes | Passou |
| 6. Troca de numero/origem remove a rota antiga | leitura | Parcial: falha na exclusao antiga e perdida (QA-M2) |
| 6. Segredo/URL completa nunca em log nem resposta | leitura: logs so `http_<status>`/`timeout`/`network`; resposta so codigo curto | Passou |
| 6. Permissao do resync | healthcare: `userOwnsScope` sobre o canal do `channelId` (IDOR coberto); delivery: `requireAccess("settings.manage", restaurantId)` e consultas filtradas por `restaurant_id` | Passou (leitura; nao executado contra banco) |
| 6. Migrations healthcare/delivery reexecutaveis | PG16 | Passou |
| 6. delivery: SAFE_COLUMNS exige migration antes do deploy | leitura (`whatsappChannel.mjs` linha 13; comentario na migration) | Confirmado: sem a migration, toda leitura do canal (`get`, `loadOwn`) falha |

## Isolamento do fluxo interno (item 4)

`git diff` do Biano mostra mudancas em `src/routes/whatsapp.ts` (+26/-4) e `src/services/whatsapp/meta-proxy.ts` (+24/-6). O README diz que `POST /webhook/meta` nao e alterado; isso nao e literalmente verdade.

Natureza das mudancas (lidas linha a linha):
- `meta-proxy.ts`: novas `diagEnabled`, `diagLog`, `safeHost`; `forwardRawMetaWebhook` troca o `try/new URL` por `safeHost` e adiciona `diagLog`. Mesmo fetch, mesmos headers, mesmo corpo, mesmo timeout. Teste existente de bytes originais passa.
- `whatsapp.ts`: `findFirst({ where: { phoneNumberId, active: true }, select: { targetUrl } })` virou `findFirst({ where: { phoneNumberId }, select: { targetUrl, active } })` e `routeUrl = route?.active ? route.targetUrl : null`. `phoneNumberId` e `@unique`, entao ha no maximo uma linha; resultado identico ao anterior para todos os casos (inexistente, inativa, ativa). Mesma tolerancia a erro de banco. O resto sao `diagLog`.
- Logica de ramo (`route` > `legacy` > `novo-saas`) intacta.

Riscos residuais nessa parte (nao sao da feature, mas estao no mesmo diff): `diagLog` fica LIGADO por padrao e loga `phoneNumberId`/`displayPhone` a cada evento da Meta (Baixo, QA-B3: ruido e dado pessoal em log; recomendado default desligado). Se esse diff vem de outra tarefa, deve ser commitado/revisado separadamente.

Se a migration nao estiver aplicada: `findFirst` com `select` explicito so le `targetUrl, active` (colunas antigas), entao o webhook interno nao quebra. Ja as rotas admin (`findUnique`/`upsert`) falham com 500 ate a migration. Nenhum outro uso de `whatsAppWebhookRoute` no codigo.

## Problemas

### Critico

**QA-C1: connect aceita o phone_number_id de qualquer numero interno do Biano (sequestro do fluxo interno).**
Passos: com segredo valido, `POST /integrations/webhook-routes/connect` com `{"phoneNumberId":"1236714352864758","targetUrl":"https://<qualquer>.supabase.co/functions/v1/whatsapp","source":"caristeo-healthcare"}` (esse e o `metaPhoneNumberId` interno em `src/scripts/set-meta-ids.ts`). Numeros internos NAO tem linha em `WhatsAppWebhookRoute`, logo `find` retorna null e nao ha 409.
Esperado: 4xx; numero interno nao pode virar rota externa.
Obtido: 200, linha ativa criada. Em `whatsapp.ts` (passo 4a) a rota ativa tem prioridade sobre o fluxo interno e legado: todo evento daquele numero passa a ser repassado ao externo (e o interno deixa de processar). Teste `todo` "CRITICO: connect com phone_number_id de numero INTERNO" em `webhook-routes-admin.qa.test.ts`.
Agravantes: (a) a guarda do legado compara `phoneNumberId === "556634016000"` ou `displayPhone` informado pelo proprio cliente (linhas 122-124, 191); o `phone_number_id` real do legado e outro valor e `displayPhone` pode ser omitido, entao o legado tambem e contornavel (teste "guarda do legado e contornavel"); (b) o healthcare, no caminho manual, so valida a regex `^\d{5,32}$` e nao confirma o numero na Meta, entao um usuario de clinica que digite o ID interno do Biano dispara isso sem atacante algum. O delivery em modo live valida o numero com a Meta (`fetchPhoneInfo`), o que mitiga.
Correcao sugerida (dev): no connect, recusar (403) se `phoneNumberId` estiver em: `env.META_PHONE_NUMBER_ID`, qualquer `metaPhoneNumberId` das tabelas de configuracao (schema linha ~342), e num env `WA_ROUTE_RESERVED_PHONE_IDS` (incluir o id do legado). Alternativa mais forte: allowlist explicita de phoneNumberId por source (`WA_ROUTE_ALLOWED_PHONE_IDS`) em vez de blocklist. Nao basear a protecao em `displayPhone` vindo do cliente.

### Alto

**QA-A1: `WA_ROUTE_ALLOWED_HOSTS=*.supabase.co` permite o projeto de qualquer cliente Supabase como destino (exfiltracao de mensagens de WhatsApp).**
Passos: connect assinado com `targetUrl=https://qualquercliente.supabase.co/functions/v1/whatsapp` (teste "wildcard aceita QUALQUER projeto": passa, inclusive `a.b.supabase.co`).
Esperado: so os projetos do healthcare e do delivery.
Obtido: aceito. Cada evento repassado leva o corpo cru da Meta (texto das mensagens, telefones, nomes) e `x-hub-signature-256`. Exige o segredo admin ou um bug/entrada errada nos clientes (ex.: `SUPABASE_URL` de outro projeto), por isso Alto e nao Critico. Recomendacao: usar refs exatos (`<ref-healthcare>.supabase.co,<ref-delivery>.supabase.co`), documentar no README como obrigatorio em producao e, no codigo, recusar entrada que comece com `*.` (ou exigir flag explicita). Idealmente amarrar host por source (healthcare so seu ref, delivery so o seu).

**QA-A2: corrida em connect (find + upsert nao atomicos) permite troca de dono.**
Passos: duas conexoes simultaneas do mesmo numero novo com `source` diferentes (teste `corrida: duas conexoes simultaneas`).
Esperado: um 200 e um 409.
Obtido: ambos 200; o `upsert` do segundo reescreve `source`/`targetUrl` do primeiro (`update` incondicional, linhas 256-259). Tambem vale para linha existente: entre o `find` e o `upsert` outro processo pode mudar o dono. Correcao: gravar condicionalmente (`INSERT ... ON CONFLICT DO UPDATE ... WHERE source = $source OR (active = false AND "deletedAt" IS NOT NULL)` via `$executeRaw`, ou `updateMany` com a condicao e `create` com tratamento de P2002 retornando 409). Teste `todo` "corrida: esperado = exatamente um 200 e um 409".

### Medio

**QA-A3 (classificado Medio): segredo unico e `source` autodeclarado.** Healthcare e delivery usam o mesmo `WA_ROUTE_ADMIN_SECRET`; qualquer um deles pode declarar `source` do outro e desconectar/ler 409 do outro (teste "source e autodeclarado"). Comprometer um sistema compromete as rotas do outro. Recomendar um segredo por source (`WA_ROUTE_ADMIN_SECRET_HEALTHCARE`, `_DELIVERY`) e derivar `source` do segredo que validou, ignorando o corpo.

**QA-M1: o repasse existente segue redirecionamento.** `forwardRawMetaWebhook` usa `fetch` padrao. Teste: host que responde 302 para `http://127.0.0.1:<porta>/interno` => o Biano faz GET la, enviando `x-wa-proxy-timestamp/signature` e `x-hub-signature-256` (SSRF cego). 307/308 com corpo quebram no Node 22 por bug do undici (nao seguem). O README chama o risco de baixo porque o host e validado na gravacao, mas o host aprovado (qualquer projeto Supabase, ver QA-A1) pode redirecionar depois da gravacao. Recomendar `redirect: "manual"` no `meta-proxy.ts` (mudanca de uma linha; o dono pediu para nao mexer ali, entao fica como decisao do dono).

**QA-M2: perda da rota antiga na troca de numero/origem.** healthcare (`manage-channel.ts`, bloco "Canal passou de biano_proxy...") e delivery (`whatsappChannel.mjs`, bloco "Biano: troca de origem/numero") chamam `syncRoutingDisconnect(prev, async () => {}, ...)`: se a exclusao antiga falhar, o estado `pending_delete` nao e persistido (persist vazio) e logo e sobrescrito pelo estado da nova conexao. O usuario recebe so um toast. Rota antiga fica ativa no Biano apontando para o sistema, sem retentativa. Correcao: registrar a pendencia (ex.: coluna/tabela de rotas orfas) ou tentar a exclusao antiga antes e abortar/avisar de forma persistente.

**QA-M3: reconexao de soft delete por outro source.** Com a decisao do dev, qualquer source assume um numero cuja rota o outro excluiu. Combinado com QA-A3 e sem verificacao de titularidade na Meta, aumenta o risco de sequestro de numero entre sistemas. Mitigacao: exigir mesmo source (ou janela/aprovacao) para reaproveitar linha excluida, ou so permitir apos prazo.

**QA-M4: rate limit atras de proxy.** `req.ip` sem `trust proxy` (nao ha em `index.ts`) e o limite roda antes da autenticacao. Se o Biano roda atras de proxy/CDN, todos compartilham o IP do proxy: 30 requisicoes invalidas por minuto de um atacante bloqueiam os clientes legitimos (429). Nao verificado onde o Biano roda; verificar e configurar `trust proxy` corretamente. Alem disso `hits.clear()` ao passar de 5000 chaves zera o limite.

### Baixo

- QA-B1: replay valido dentro de 5 min sem nonce. Um `connect` capturado reativa a rota depois de um `disconnect` legitimo na mesma janela. Exige captura de trafego TLS; baixo. Recomendar nonce/idempotency key curta.
- QA-B2: `WA_ROUTE_ADMIN_SECRET` sem tamanho minimo (segredo de 1 caractere funciona). Recomendar exigir >= 32 caracteres, senao 503.
- QA-B3: `WA_DIAG_LOG` ligado por padrao loga ids de telefone por evento (ver Isolamento).
- QA-B4: cache/rotulo: `label` aceita qualquer texto ate 100 chars (sem risco de injecao de log, pois o log usa JSON.stringify e nao inclui label). Informativo.
- QA-B5: UI do healthcare mostra o texto "Cadastre no Biano o numero ... com destino <url>" mesmo agora que o cadastro e automatico (`WhatsAppTab.tsx` linhas ~1064-1066). Texto desatualizado, confunde o usuario.

## Migracao manual do Biano (item 5)

- `20261125_whatsapp_webhook_route_admin.sql`: 4 `ADD COLUMN IF NOT EXISTS` (TEXT, TIMESTAMP(3)) idempotentes; tipos batem com o schema.prisma (`String?`, `DateTime?`), `db pull` geraria o mesmo modelo. Rodar `prisma generate` antes do deploy do Biano.
- `20261119_whatsapp_webhook_route.sql` (alterado): so comentarios; a tabela criada pelo Prisma nao tem DEFAULT em `id`/`updatedAt` (o arquivo manual de 20261119 tem DEFAULT; ha divergencia entre as duas formas de criar a tabela, o INSERT manual com id/updatedAt funciona nas duas).
- **Linha existente do healthcare (`1278785958662616`, criada a mao, sem source)**: a API a trata como interna e o healthcare recebera 409 ao conectar (`routing_status = error`, `http_409`) e ao excluir. Comportamento intencional para linhas internas, mas bloqueia o caso real. UPDATE proposto (testado em PG16), a rodar uma vez, depois da migration e antes do deploy do healthcare:
  ```sql
  UPDATE "WhatsAppWebhookRoute"
     SET "source" = 'caristeo-healthcare', "connectedAt" = COALESCE("connectedAt", now())
   WHERE "phoneNumberId" = '1278785958662616' AND "source" IS NULL;
  ```
  Conferir antes que `targetUrl` aponta para o projeto do healthcare. Nenhuma outra linha deve receber source.

## Pendencias para o usuario

1. Decidir e mandar corrigir QA-C1 (bloqueador) e QA-A2; definir refs exatos em `WA_ROUTE_ALLOWED_HOSTS` (QA-A1) antes de qualquer deploy.
2. Rodar o UPDATE da linha do healthcare apos a migration.
3. Ordem de deploy: SQL Biano -> `prisma generate` + secrets (`WA_ROUTE_ADMIN_SECRET`, `WA_ROUTE_ALLOWED_HOSTS`) -> Biano -> migrations healthcare e delivery (ANTES das functions) -> functions com `BIANO_ROUTE_MODE=live` (valor exato) e `BIANO_ROUTE_ADMIN_URL`/`BIANO_ROUTE_ADMIN_SECRET`.
4. Decidir segredo por source (QA-A3), `redirect: "manual"` no meta-proxy (QA-M1) e a politica de reconexao entre sources (QA-M3).
5. Verificar se o Biano roda atras de proxy (QA-M4).
6. Testar de ponta a ponta com `BIANO_ROUTE_MODE=live` em staging; so os clientes simulados (fetch falso) foram executados.
7. Reteste de QA apos correcoes: reexecutar `npx tsx --test src/routes/webhook-routes-admin.qa.test.ts`; os dois `todo` devem passar a "pass" (converter para testes normais).

## Arquivos de teste adicionados

- `/home/linux-daniel/dev/Biano/api_biano/src/routes/webhook-routes-admin.qa.test.ts` (nao incluido no script `npm test`; incluir apos as correcoes).
