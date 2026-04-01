## WhatsApp Verification (Evolution API)

Projeto simples para **confirmar contas via WhatsApp** usando a **Evolution API**.

### Como funciona (visão geral)

1. O utilizador cria conta na Comunidade e recebe um **código** (ex.: `99999`)
2. O frontend abre um link para WhatsApp com mensagem pré-definida:
   - `Gostaria de confirmar meu acesso a comunidade RPM com o codigo: 99999`
3. A Evolution API recebe a mensagem e envia um webhook `MESSAGES_UPSERT` para este serviço.
4. Este serviço valida a mensagem, extrai o código e chama a API do backend da Comunidade para **confirmar a conta** e gravar o WhatsApp que enviou o código.

### Componentes.

- **Evolution API**: container `atendai/evolution-api`
- **Webhook receiver**: `app/` (Node/Express)

### Variáveis importantes (.env na VPS)

- `EVOLUTION_API_KEY`: chave para usar a Evolution
- `EVOLUTION_INSTANCE`: nome da instância (ex.: `comunidade`)
- `WEBHOOK_PUBLIC_URL`: URL pública do receiver (ex.: `https://wa-verify.seudominio.com/webhook/evolution`)
- `COMMUNITY_API_URL`: URL do backend da Comunidade (ex.: `https://api-comunidade...`)
- `COMMUNITY_INTERNAL_SECRET`: segredo para autenticar chamadas internas
- `WEBHOOK_SECRET`: segredo para validar chamadas do webhook (o header HTTP tem de ser **exactamente** este valor)

### Webhook, Nginx e header `x-webhook-secret`

O receiver compara o header **`x-webhook-secret`** com **`WEBHOOK_SECRET`** do ambiente. A Evolution normalmente **não** envia esse header.

Em produção, o Nginx em `wa-verify` deve fazer **`proxy_set_header x-webhook-secret "<mesmo valor que WEBHOOK_SECRET>";`** no `location` que faz `proxy_pass` para o receiver. Assim os pedidos HTTPS funcionam **sem** colocares o segredo à mão no `curl`.

**Não uses** texto placeholder tipo `SEU_WEBHOOK_SECRET_DO_ENV` no header: isso **não** é o valor real e resulta em **403 Forbidden**.

### Testar o receiver na VPS

**Pelo domínio (igual à Evolution; Nginx injeta o segredo):**

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/connection-update" \
  -H 'content-type: application/json' \
  --data '{}'
```

**Direto à porta local** (sem Nginx): tens de passar o segredo **real** vindo do `.env`:

```bash
cd /opt/wa-verify
set -a && . ./.env && set +a

curl -i -X POST "http://127.0.0.1:13100/webhook/evolution/connection-update" \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  --data '{}'
```

Para simular uma mensagem com código (deve bater com o texto que o registo envia ao WhatsApp):

```bash
curl -i -X POST "https://wa-verify.seudominio.com/webhook/evolution/messages-upsert" \
  -H 'content-type: application/json' \
  --data '{"data":{"key":{"remoteJid":"351999999999@s.whatsapp.net"},"message":{"conversation":"codigo: 12345"}}}'
```

### Deploy na VPS (resumo)

Usar `deploy/docker-compose.vps.yml`, criar `/opt/wa-verify/.env`, e subir:

```bash
cd /opt/wa-verify
docker compose pull
docker compose up -d
```

