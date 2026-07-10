## WhatsApp Evolution (wa-verify)

Ponte entre a **Evolution API** e o backend da Comunidade. Recebe webhooks `messages.upsert`, filtra mensagens de **grupos** WhatsApp e reencaminha-as para ingestão no NestJS.

> O nome histórico do projeto (`wa-verify`) e a pasta `whatsapp-evolution-verify` remetem a um fluxo antigo de **confirmação de conta por código** — já não existe. Hoje o receiver só faz forward de mensagens de grupo.

### Como funciona

1. A Evolution API recebe mensagens nos grupos monitorizados e envia webhook `MESSAGES_UPSERT` para este serviço.
2. O **receiver** (`app/server.js`) ignora eventos de ruído (presence, contacts, chats, etc.) e processa apenas mensagens de grupo (`@g.us`) que não sejam `fromMe`.
3. Para cada mensagem, extrai remetente, texto e/ou mídia (imagem/vídeo, com base64 quando o Webhook Base64 está ativo).
4. Reencaminha ao backend com `COMMUNITY_INTERNAL_SECRET` no header `x-internal-secret`:
   - `POST /whatsapp-scan/ingest` — scan de imóveis (classificação IA + rascunho)
   - `POST /job-offers/whatsapp/ingest` — ofertas de trabalho

A configuração dos grupos monitorizados, filtros de remetente e lógica de negócio ficam no **backend** (`whatsapp-scan`, `job-offers`), não neste receiver.

### Componentes

- **Evolution API**: `evoapicloud/evolution-api:v2.3.7` (versão fixa; evitar `:homolog`). O CI **não** reinicia a Evolution — só o receiver.
- **Webhook receiver**: `app/` (Node/Express), imagem `ghcr.io/diegofischerdev/wa-verify-receiver:main`

### Variáveis importantes (.env na VPS)

**Receiver**

- `WEBHOOK_PUBLIC_URL`: URL pública do receiver (ex.: `https://wa-verify.seudominio.com/webhook/evolution`)
- `WEBHOOK_SECRET`: segredo validado no header `x-webhook-secret`
- `COMMUNITY_API_URL`: URL do backend (ex.: `https://api-comunidade...`)
- `COMMUNITY_INTERNAL_SECRET`: segredo partilhado com o backend (igual ao `.env` do NestJS)
- `LOG_WEBHOOK=1`: regista eventos e reencaminhamentos no stdout (debug)
- `WEBHOOK_BODY_LIMIT` (opcional): limite do body JSON (default **256mb**; mídia em base64)

**Evolution API**

- `EVOLUTION_API_KEY`: chave da Evolution
- `EVOLUTION_DB_PASSWORD`: password do Postgres da Evolution
- `EVOLUTION_INSTANCE`: instância principal (ex.: `comunidade`)
- `EVOLUTION_INSTANCE_SECONDARY`: instância secundária (opcional)
- `EVOLUTION_API_URL`: URL interna da Evolution (usada pelo backend para buscar mídia quando o webhook não traz base64)
- `EVOLUTION_CHATBOT_INSTANCES`: instâncias que processam gatilhos em **conversas diretas** (ex.: `comunidade MEO`). Quando o **admin** envia «link para agendar chamada» numa DM (`fromMe: true`), o backend responde ao **cliente** com o link `/agendar?whatsapp=…&name=…`.

### Webhook, Nginx e header `x-webhook-secret`

O receiver compara o header **`x-webhook-secret`** com **`WEBHOOK_SECRET`**. A Evolution normalmente **não** envia esse header.

Em produção, o Nginx em `wa-verify` deve fazer **`proxy_set_header x-webhook-secret "<mesmo valor que WEBHOOK_SECRET>";`** no `location` que faz `proxy_pass` para o receiver.

Se a Evolution logar **`413`** / **`Payload Too Large`**, aumenta o limite no Nginx:

```nginx
client_max_body_size 256M;
```

**Não uses** placeholder tipo `SEU_WEBHOOK_SECRET_DO_ENV` no header — resulta em **403 Forbidden**.

### Troubleshooting

1. Com `LOG_WEBHOOK=1`, nos logs deve aparecer `[wa-verify] webhook messages.upsert` e, ao reencaminhar, `scan forwarded` / `job-offers forwarded`.
2. Se aparecer `ignored: <evento>`, o webhook não é `messages.upsert` — comportamento esperado para presence/contacts/etc.
3. Mensagens de grupo ignoradas no backend (`ignored_group_not_monitored`): o `groupJid` não está configurado como grupo ativo em `whatsapp-scan`.
4. Confirma `COMMUNITY_API_URL` e `COMMUNITY_INTERNAL_SECRET` **iguais** ao backend.
5. Confirma que o webhook global da Evolution aponta para `/webhook/evolution` e que o Nginx injeta `x-webhook-secret`.

### Testar o receiver na VPS

**Health check:**

```bash
curl -s "http://127.0.0.1:13100/health"
```

**Pelo domínio (Nginx injeta o segredo):**

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/messages-upsert" \
  -H 'content-type: application/json' \
  --data '{}'
```

**Direto à porta local** (sem Nginx): passa o segredo real do `.env`:

```bash
cd /opt/wa-verify
set -a && . ./.env && set +a

curl -i -X POST "http://127.0.0.1:13100/webhook/evolution/messages-upsert" \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  --data '{}'
```

**Simular mensagem de grupo** (deve reencaminhar para o backend se `COMMUNITY_*` estiver configurado):

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/messages-upsert" \
  -H 'content-type: application/json' \
  --data '{
    "event": "messages.upsert",
    "instance": "comunidade",
    "data": {
      "key": {
        "remoteJid": "120363000000000000@g.us",
        "fromMe": false,
        "id": "TESTMSG001",
        "participant": "351912345678@s.whatsapp.net"
      },
      "message": { "conversation": "T3 apartamento Lisboa 250000" },
      "messageTimestamp": 1700000000
    }
  }'
```

### Deploy na VPS (resumo)

`/opt/wa-verify` usa `docker-compose.yml` + `.env` (não precisa da pasta `app/`). O **receiver** vem de `ghcr.io/diegofischerdev/wa-verify-receiver:main` (build no GitHub Actions).

```bash
cd /opt/wa-verify
docker compose pull receiver
docker compose up -d receiver
```

Desenvolvimento local com build:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build receiver
```

**Qual ficheiro Compose usar**

| Situação | Comando |
|----------|---------|
| Repositório completo com `docker-compose.yml` na raiz (recomendado) | `docker compose ps` / `docker compose logs -f receiver` |
| Só existe `deploy/docker-compose.vps.yml` | `docker compose -f deploy/docker-compose.vps.yml ps` (a partir da **raiz** do repo) |
| Erro `open .../deploy/docker-compose.vps.yml: no such file or directory` | Na VPS usa o `docker-compose.yml` na raiz: `ls -la /opt/wa-verify/*.yml` |

### Deploy falhou com `502 Bad Gateway` no push ao GHCR

Erro **transitório** do GitHub Container Registry.

1. **Re-run** do workflow em Actions → «Deploy WhatsApp verify (main)» → *Re-run failed jobs*
2. Ou dispara manualmente: Actions → *Run workflow*
3. O workflow tenta o push **até 4 vezes** com intervalo crescente (45s, 90s, 135s)

Se o pull na VPS falhar com **unauthorized**, torna o package público no GitHub ou adiciona o secret `GHCR_PULL_TOKEN` (PAT com `read:packages`).
